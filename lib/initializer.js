const cds = require('@sap/cds')
const LOG = cds.log('otel')

const fs = require('fs')
const xsenv = require('@sap/xsenv')

const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { SemanticAttributes, SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions')
const { Resource } = require('@opentelemetry/resources')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { B3Propagator, B3InjectEncoding } = require('@opentelemetry/propagator-b3')
const { JaegerPropagator } = require('@opentelemetry/propagator-jaeger')
const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } = require('@opentelemetry/core')
const {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  AlwaysOnSampler,
  SamplingDecision,
  ParentBasedSampler,
  AlwaysOffSampler,
  TraceIdRatioBasedSampler
} = require('@opentelemetry/sdk-trace-base')
const { SpanKind, trace, metrics, diag, DiagConsoleLogger } = require('@opentelemetry/api')
const {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  AggregationTemporality
} = require('@opentelemetry/sdk-metrics')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger') // REVISIT: stuff like this should not be a direct dependency!!!
const { OTLPTraceExporter: OTLPTraceExporterGrpc } = require('@opentelemetry/exporter-trace-otlp-grpc')
const { OTLPTraceExporter: OTLPTraceExporterHttp } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPTraceExporter: OTLPTraceExporterProto } = require('@opentelemetry/exporter-trace-otlp-proto')
const { OTLPMetricExporter: OTLPMetricExporterGrpc } = require('@opentelemetry/exporter-metrics-otlp-grpc')
const { OTLPMetricExporter: OTLPMetricExporterHttp } = require('@opentelemetry/exporter-metrics-otlp-http')
const { OTLPMetricExporter: OTLPMetricExporterProto } = require('@opentelemetry/exporter-metrics-otlp-proto')

const { instrumentations } = require('../index')
const registerMetrics = require('./metrics')
const { CDSConsoleMetricsExporter } = require('./metrics/CDSConsoleMetricsExporter')
const { addInstrumentation } = require('./traces/instrumentation')
const { CDSConsoleExporter } = require('./traces/CDSConsoleExporter')
const { getLogLevel } = require('./utils/LogLevelProvider')

diag.setLogger(new DiagConsoleLogger(), getLogLevel())

module.exports = class OTELInitializer {
  /**
   * Registers openTelemetry trace provider
   * cds.env.trace.tracer is the place where the tracer is stored
   * @returns
   */
  static registerProvider() {
    this.setNameAndVersion()
    const resource = this.getResource()
    const provider = new NodeTracerProvider({
      sampler: filterSampler(ignoreSpecifiedPaths, this.setSampler()),
      resource
    })
    const exporters = this.getExporters()
    if (process.env.NODE_ENV !== 'production' || !isDynatraceEnabled()) this.setSpanProcessor(provider, exporters.trace)
    provider.register({
      propagator: this.setPropagator()
    })
    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: instrumentations
    })
    if (!cds.env.trace.tracer) cds.env.trace.tracer = trace.getTracer(cds.env.trace.name, cds.env.trace.version)
    addInstrumentation()

    // get the Dynatrace metadata for entity-awareness
    let dtmetadata = new Resource({})
    for (let name of [
      'dt_metadata_e617c525669e072eebe3d0f08212e8f2.json',
      '/var/lib/dynatrace/enrichment/dt_metadata.json'
    ]) {
      try {
        dtmetadata = dtmetadata.merge(
          new Resource(
            JSON.parse(
              fs
                .readFileSync(name.startsWith('/var') ? name : fs.readFileSync(name).toString('utf-8').trim())
                .toString('utf-8')
            )
          )
        )
        break
      } catch {
        /** */
      }
    }
    // Add metrics
    const metricReader = new PeriodicExportingMetricReader({
      exporter: exporters.metrics,
      exportIntervalMillis: 50000
    })
    const meterProvider = new MeterProvider({
      resource: new Resource({}).merge(resource).merge(dtmetadata)
    })
    meterProvider.addMetricReader(metricReader)
    metrics.setGlobalMeterProvider(meterProvider)
    registerMetrics()
  }

  static setNameAndVersion() {
    // REVISIT: Determine app name and version via package.json
    cds.env.trace.name = 'CAP Application'
    cds.env.trace.version = 1.0
    if (fs.existsSync(cds.env._home + '/package.json')) {
      const pack = JSON.parse(fs.readFileSync(cds.env._home + '/package.json', 'utf8'))
      cds.env.trace.name = pack.name
      cds.env.trace.version = pack.version
    }
  }

  static getResource() {
    // Think about adding more from:
    // https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/service.md
    let resourceAttributes = {
      [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME
        ? process.env.OTEL_SERVICE_NAME
        : cds.env.trace.name, // Set service name to CDS Service
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: cds.env.trace.name,
      [SemanticResourceAttributes.SERVICE_VERSION]: cds.env.trace.version,

      [SemanticResourceAttributes.PROCESS_RUNTIME_NAME]: 'nodejs',
      [SemanticResourceAttributes.PROCESS_RUNTIME_VERSION]: process.versions.node,

      [SemanticResourceAttributes.PROCESS_PID]: process.pid,
      ['process.parent_pid']: process.ppid,
      // [SemanticResourceAttributes.PROCESS_EXECUTABLE_NAME]: process.execArgv, // REVISIT: What is the executable name
      [SemanticResourceAttributes.PROCESS_EXECUTABLE_PATH]: process.execPath,
      // [SemanticResourceAttributes.PROCESS_OWNER]: process.owner, // REVISIT: Who should be the owner
      'sap.visibility.level': process.env.NODE_ENV !== 'production' ? 'confidential' : 'internal'
      // TODO: More attributes
    }
    if (process.env.CF_INSTANCE_GUID)
      resourceAttributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
    Object.assign(resourceAttributes, addCFAttributes())
    return new Resource(resourceAttributes)
  }

  static setSpanProcessor(provider, exporter) {
    if (!exporter) return
    let spanProcessor
    if (process.env.NODE_ENV !== 'production') {
      spanProcessor = new SimpleSpanProcessor(exporter)
    } else {
      const batchConfig = {
        exportTimeoutMillis: process.env.OTEL_BSP_EXPORT_TIMEOUT || 30000,
        maxExportBatchSize: process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE || 512,
        maxQueueSize: process.env.OTEL_BSP_MAX_QUEUE_SIZE || 2048,
        scheduledDelayMillis: process.env.OTEL_BSP_SCHEDULE_DELAY || 5000
      }
      spanProcessor = new BatchSpanProcessor(exporter, batchConfig)
    }
    provider.addSpanProcessor(spanProcessor)
  }

  static setSampler() {
    process.env.OTEL_TRACES_SAMPLER = process.env.OTEL_TRACES_SAMPLER || 'parentbased_always_on'
    switch (process.env.OTEL_TRACES_SAMPLER) {
      case 'always_on':
        return new AlwaysOnSampler()
      case 'always_off':
        return new AlwaysOffSampler()
      case 'traceidratio':
        return new TraceIdRatioBasedSampler(process.env.OTEL_TRACES_SAMPLER_ARG)
      case 'parentbased_always_on':
        return new ParentBasedSampler({ root: new AlwaysOnSampler() })
      case 'parentbased_always_off':
        return new ParentBasedSampler({ root: new AlwaysOffSampler() })
      case 'parentbased_traceidratio':
        return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(process.env.OTEL_TRACES_SAMPLER_ARG) })
    }
  }

  static setPropagator() {
    const propagators = []
    if (process.env.OTEL_PROPAGATORS) {
      process.env.OTEL_PROPAGATORS.split(',').forEach(propa => {
        switch (propa) {
          case 'tracecontext':
            propagators.push(new W3CTraceContextPropagator())
            break
          case 'baggage':
            propagators.push(new W3CBaggagePropagator())
            break
          case 'b3':
            propagators.push(new B3Propagator({ injectEncoding: B3InjectEncoding.SINGLE_HEADER }))
            break
          case 'b3multi':
            propagators.push(new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER }))
            break
          case 'jaeger':
            propagators.push(new JaegerPropagator())
            break
          default:
            propagators.push(new W3CTraceContextPropagator())
            break
        }
      })
    } else {
      propagators.push(new W3CTraceContextPropagator())
    }
    return new CompositePropagator({
      propagators: propagators
    })
  }

  // TODO: If dynatrace service is bound and contains API details, use those
  // Adjust function to return object with exporters
  // Write metric parts to cds.env.metrics
  /**
   *  @returns Exporter
   */
  static getExporters() {
    const result = { trace: null, metrics: null }
    // cds.env.trace.exporter allows to customize SpanExporter if needed
    if (!cds.env.trace.exporter) {
      try {
        if (!cds.env.trace.exportOptions) cds.env.trace.exportOptions = {}
        if (cds.env.trace.export === 'jaeger') {
          cds.env.trace.exporter = new JaegerExporter(cds.env.trace.exportOptions)
        } else if (cds.env.trace.export === 'grpc') {
          cds.env.trace.exporter = new OTLPTraceExporterGrpc(cds.env.trace.exportOptions)
        } else if (cds.env.trace.export === 'proto' || isDynatraceEnabled()) {
          // Ensure that HTTP proto is used in dynatrace case
          cds.env.trace.exporter = new OTLPTraceExporterProto(cds.env.trace.exportOptions)
        } else if (cds.env.trace.export === 'http' || process.env.NODE_ENV === 'production') {
          // Ensure that HTTP is used by default in production
          cds.env.trace.exporter = new OTLPTraceExporterHttp(cds.env.trace.exportOptions)
        } else {
          if (cds.env.trace.format === 'json')
            cds.env.trace.exporter = new ConsoleSpanExporter(cds.env.trace.exportOptions)
          else cds.env.trace.exporter = new CDSConsoleExporter(cds.env.trace.exportOptions)
        }
      } catch (error) {
        throw new Error(`Error during initialization of Exporter , ${error}`)
      }
    }
    if (!cds.env.metrics.exporter) {
      try {
        if (!cds.env.metrics.export) cds.env.metrics.export = cds.env.trace.export
        if (!cds.env.metrics.exportOptions) {
          cds.env.metrics.exportOptions = {}
          const getDynatraceSRV = () => {
            try {
              // REVISIT: don't use xsenv for this easy lookup
              const services = xsenv.readServices()
              for (const srv in services) {
                if (srv.match('dynatrace')) return services[srv]
              }
            } catch (e) {
              LOG.error('No bound dynatrace service found!')
            }
            return null
          }
          if (isDynatraceEnabled() && getDynatraceSRV()) {
            const {
              credentials: { metrics_token, apiurl }
            } = getDynatraceSRV()
            cds.env.metrics.exportOptions = {
              url: `${apiurl}/v2/otlp/v1/metrics`,
              headers: {
                Authorization: `Api-Token ${metrics_token}`
              },
              temporalityPreference: AggregationTemporality.DELTA
            }
            LOG.debug('Dynatrace metrics export options', cds.env.metrics.exportOptions)
          } else {
            LOG.debug(
              'Dynatrace not enabled or dynatrace service not found',
              `Dynatrace enabled ${isDynatraceEnabled()}`
            )
          }
        }
        if (cds.env.metrics.export === 'grpc') {
          LOG.debug('OTLP Metric grpc exporter is being used')
          cds.env.metrics.exporter = new OTLPMetricExporterGrpc(cds.env.metrics.exportOptions)
        } else if (cds.env.metrics.export === 'proto' || isDynatraceEnabled()) {
          // Ensure that HTTP proto is used in dynatrace case
          LOG.debug('OTLP Metric proto exporter is being used')
          cds.env.metrics.exporter = new OTLPMetricExporterProto(cds.env.metrics.exportOptions)
        } else if (cds.env.metrics.export === 'http' || process.env.NODE_ENV === 'production') {
          // Ensure that HTTP is used by default in production
          LOG.debug('OTLP Metric http exporter is being used')
          cds.env.metrics.exporter = new OTLPMetricExporterHttp(cds.env.metrics.exportOptions)
        } else {
          LOG.debug('OTLP Metric console exporter is being used')
          if (cds.env.metrics.format === 'json')
            cds.env.metrics.exporter = new ConsoleMetricExporter(cds.env.metrics.exportOptions)
          else cds.env.metrics.exporter = new CDSConsoleMetricsExporter(cds.env.metrics.exportOptions)
        }
      } catch (error) {
        throw new Error(`Error during initialization of Exporter , ${error}`)
      }
    }
    result.trace = cds.env.trace.exporter
    result.metrics = cds.env.metrics.exporter
    LOG.debug('Exporter', result)
    return result
  }
}

const isDynatraceEnabled = () =>
  process.env.NODE_ENV === 'production' &&
  fs.readFileSync(cds.env._home + '/package.json', 'utf8').match('@dynatrace/oneagent-sdk')

/**
 *
 * @param {any} filterFn
 * @param {any} parent
 * @returns
 */
function filterSampler(filterFn, parent) {
  return {
    shouldSample(ctx, tid, spanName, spanKind, attr, links) {
      if (!filterFn(spanName, spanKind, attr)) {
        return { decision: SamplingDecision.NOT_RECORD }
      }
      return parent.shouldSample(ctx, tid, spanName, spanKind, attr, links)
    }
  }
}

function ignoreSpecifiedPaths(spanName, spanKind, attributes) {
  return (
    !Array.isArray(cds.env.trace.ignorePaths) ||
    (Array.isArray(cds.env.trace.ignorePaths) && !cds.env.trace.ignorePaths.some(path => path === spanName)
      ? spanKind !== SpanKind.SERVER ||
        !cds.env.trace.ignorePaths.some(path => path === attributes[SemanticAttributes.HTTP_ROUTE])
      : false)
  )
}

/**
 * Specified CF attributes in https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/cf.md
 * @returns attribute object
 */
function addCFAttributes() {
  let result = {}
  const vcapApplication = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)
  if (!vcapApplication) return result
  result['sap.cf.source_id'] = vcapApplication.application_id
  result['sap.cf.instance_id'] = process.env.CF_INSTANCE_GUID
  result['sap.cf.app_id'] = vcapApplication.application_id
  result['sap.cf.app_name'] = vcapApplication.name
  result['sap.cf.space_id'] = vcapApplication.space_id
  result['sap.cf.space_name'] = vcapApplication.space_name
  result['sap.cf.org_id'] = vcapApplication.organization_id
  result['sap.cf.org_name'] = vcapApplication.organization_name
  // result["sap.cf.source_type"] = vcapApplication -- for logs
  result['sap.cf.process.id'] = vcapApplication.process_id
  result['sap.cf.process.instance_id'] = vcapApplication.process_id // REVISIT: Not sure
  result['sap.cf.process.type'] = vcapApplication.process_type
  return result
}
