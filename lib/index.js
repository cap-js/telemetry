const cds = require('@sap/cds')
const LOG = cds.log('otel')

const fs = require('fs')
const xsenv = require('@sap/xsenv')

// ----------------------------------------------------
// @opentelemetry
//

const { trace, metrics, diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { Resource } = require('@opentelemetry/resources')

const { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  AggregationTemporality
} = require('@opentelemetry/sdk-metrics')

const { OTLPTraceExporter: OTLPTraceExporterHttp } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPTraceExporter: OTLPTraceExporterProto } = require('@opentelemetry/exporter-trace-otlp-proto')
const { OTLPMetricExporter: OTLPMetricExporterHttp } = require('@opentelemetry/exporter-metrics-otlp-http')
const { OTLPMetricExporter: OTLPMetricExporterProto } = require('@opentelemetry/exporter-metrics-otlp-proto')

// ----------------------------------------------------
// own
//

const { getInstrumentations, getResource, getSampler, getPropagator } = require('./utils/config')

const { addInstrumentation } = require('./trace/instrumentation')
const registerMetrics = require('./metrics')
const { MyConsoleMetricExporter, MyConsoleSpanExporter } = require('./exporter')

// ----------------------------------------------------

function _getDiagLogLevel() {
  if (process.env.OTEL_LOG_LEVEL) return DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase()]
  if (LOG._trace) return DiagLogLevel.VERBOSE
  if (LOG._debug) return DiagLogLevel.DEBUG
  if (LOG._info) return DiagLogLevel.INFO
  if (LOG._warn) return DiagLogLevel.WARN
  if (LOG._error) return DiagLogLevel.ERROR
  return DiagLogLevel.NONE
}
diag.setLogger(new DiagConsoleLogger(), _getDiagLogLevel())

// ----------------------------------------------------

function setSpanProcessor(provider, exporter) {
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

// TODO: If dynatrace service is bound and contains API details, use those
// Adjust function to return object with exporters
// Write metric parts to cds.env.requires.otel.metrics
/**
 *  @returns Exporter
 */
function getExporters() {
  const result = { trace: null, metrics: null }

  if (!cds.env.requires.otel.trace.exporter) {
    try {
      if (!cds.env.requires.otel.trace.exportOptions) cds.env.requires.otel.trace.exportOptions = {}
      if (cds.env.requires.otel.trace.export === 'jaeger') {
        if (dependencyExists('@opentelemetry/exporter-jaeger')) {
          const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
          cds.env.requires.otel.trace.exporter = new JaegerExporter(cds.env.requires.otel.trace.exportOptions)
        } else {
          LOG.error(
            `Please run 'npm i @opentelemetry/exporter-jaeger' to be able to use jaeger as an exporter for the OpenTelemetry plugin`
          )
        }
      } else if (cds.env.requires.otel.trace.export === 'grpc') {
        if (dependencyExists('@opentelemetry/exporter-trace-otlp-grpc')) {
          const { OTLPTraceExporter: OTLPTraceExporterGrpc } = require('@opentelemetry/exporter-trace-otlp-grpc')
          cds.env.requires.otel.trace.exporter = new OTLPTraceExporterGrpc(cds.env.requires.otel.trace.exportOptions)
        } else {
          LOG.error(`Please run 'npm i @opentelemetry/exporter-trace-otlp-grpc' to use grpc as the trace exporter`)
        }
      } else if (cds.env.requires.otel.trace.export === 'proto' || isDynatraceEnabled()) {
        // Ensure that HTTP proto is used in dynatrace case
        cds.env.requires.otel.trace.exporter = new OTLPTraceExporterProto(cds.env.requires.otel.trace.exportOptions)
      } else if (cds.env.requires.otel.trace.export === 'http' || process.env.NODE_ENV === 'production') {
        // Ensure that HTTP is used by default in production
        cds.env.requires.otel.trace.exporter = new OTLPTraceExporterHttp(cds.env.requires.otel.trace.exportOptions)
      } else {
        if (cds.env.requires.otel.trace.format === 'json')
          cds.env.requires.otel.trace.exporter = new ConsoleSpanExporter(cds.env.requires.otel.trace.exportOptions)
        else cds.env.requires.otel.trace.exporter = new MyConsoleSpanExporter(cds.env.requires.otel.trace.exportOptions)
      }
    } catch (error) {
      throw new Error(`Error during initialization of Exporter , ${error}`)
    }
  }
  result.trace = cds.env.requires.otel.trace.exporter

  if (!cds.env.requires.otel.metrics.exporter) {
    try {
      if (!cds.env.requires.otel.metrics.export)
        cds.env.requires.otel.metrics.export = cds.env.requires.otel.trace.export
      if (!cds.env.requires.otel.metrics.exportOptions) {
        cds.env.requires.otel.metrics.exportOptions = {}
        const getDynatraceSRV = () => {
          try {
            // FIXME: don't use xsenv for this easy lookup
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
          cds.env.requires.otel.metrics.exportOptions = {
            url: `${apiurl}/v2/otlp/v1/metrics`,
            headers: {
              Authorization: `Api-Token ${metrics_token}`
            },
            temporalityPreference: AggregationTemporality.DELTA
          }
          LOG.debug('Dynatrace metrics export options', cds.env.requires.otel.metrics.exportOptions)
        } else {
          LOG.debug('Dynatrace not enabled or dynatrace service not found', `Dynatrace enabled ${isDynatraceEnabled()}`)
        }
      }
      if (cds.env.requires.otel.metrics.export === 'grpc') {
        if (dependencyExists('@opentelemetry/exporter-trace-otlp-grpc')) {
          LOG.debug('OTLP Metric grpc exporter is being used')
          const { OTLPMetricExporter: OTLPMetricExporterGrpc } = require('@opentelemetry/exporter-metrics-otlp-grpc')
          cds.env.requires.otel.metrics.exporter = new OTLPMetricExporterGrpc(
            cds.env.requires.otel.metrics.exportOptions
          )
        } else {
          LOG.error(`Please run 'npm i @opentelemetry/exporter-trace-otlp-grpc' to use grpc as the metrics exporter`)
        }
      } else if (cds.env.requires.otel.metrics.export === 'proto' || isDynatraceEnabled()) {
        // Ensure that HTTP proto is used in dynatrace case
        LOG.debug('OTLP Metric proto exporter is being used')
        cds.env.requires.otel.metrics.exporter = new OTLPMetricExporterProto(
          cds.env.requires.otel.metrics.exportOptions
        )
      } else if (cds.env.requires.otel.metrics.export === 'http' || process.env.NODE_ENV === 'production') {
        // Ensure that HTTP is used by default in production
        LOG.debug('OTLP Metric http exporter is being used')
        cds.env.requires.otel.metrics.exporter = new OTLPMetricExporterHttp(cds.env.requires.otel.metrics.exportOptions)
      } else {
        LOG.debug('OTLP Metric console exporter is being used')
        if (cds.env.requires.otel.metrics.format === 'json')
          cds.env.requires.otel.metrics.exporter = new ConsoleMetricExporter(
            cds.env.requires.otel.metrics.exportOptions
          )
        else
          cds.env.requires.otel.metrics.exporter = new MyConsoleMetricExporter(
            cds.env.requires.otel.metrics.exportOptions
          )
      }
    } catch (error) {
      throw new Error(`Error during initialization of Exporter , ${error}`)
    }
  }
  result.metrics = cds.env.requires.otel.metrics.exporter

  LOG._debug && LOG.debug('Exporter', result)

  return result
}

const isDynatraceEnabled = () =>
  process.env.NODE_ENV === 'production' &&
  fs.readFileSync(cds.env._home + '/package.json', 'utf8').match('@dynatrace/oneagent-sdk')

function dependencyExists(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

// ----------------------------------------------------

// ----------------------------------------------------

module.exports = function () {
  /**
   * Registers OpenTelemetry trace provider
   * cds.env.requires.otel.trace.tracer is the place where the tracer is stored
   */
  // REVISIT: Determine app name and version via package.json
  cds.env.requires.otel.trace.name = 'CAP Application'
  cds.env.requires.otel.trace.version = 1.0
  if (fs.existsSync(cds.env._home + '/package.json')) {
    const pack = JSON.parse(fs.readFileSync(cds.env._home + '/package.json', 'utf8'))
    cds.env.requires.otel.trace.name = pack.name
    cds.env.requires.otel.trace.version = pack.version
  }

  const instrumentations = getInstrumentations()
  const resource = getResource()
  const sampler = getSampler()
  const tracerProvider = new NodeTracerProvider({ resource, sampler })

  // --- HERE ---

  const exporters = getExporters()

  if (process.env.NODE_ENV !== 'production' || !isDynatraceEnabled()) setSpanProcessor(tracerProvider, exporters.trace)

  const propagator = getPropagator()
  tracerProvider.register({ propagator })

  registerInstrumentations({ tracerProvider, instrumentations })

  if (!cds.env.requires.otel.trace.tracer) {
    cds.env.requires.otel.trace.tracer = trace.getTracer(
      cds.env.requires.otel.trace.name,
      cds.env.requires.otel.trace.version
    )
  }

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
