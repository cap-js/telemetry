const cds = require('@sap/cds')
const LOG = cds.log('otel')

const fs = require('fs')

// ----------------------------------------------------
// @opentelemetry
//

const { trace, metrics, diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { Resource } = require('@opentelemetry/resources')

const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')

// ----------------------------------------------------
// own
//

const { getInstrumentations, getResource, getSampler, getPropagator, getExporters } = require('./utils/config')

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

const isDynatraceEnabled = () =>
  process.env.NODE_ENV === 'production' &&
  fs.readFileSync(cds.env._home + '/package.json', 'utf8').match('@dynatrace/oneagent-sdk')

// ----------------------------------------------------

// ----------------------------------------------------

module.exports = function () {
  /**
   * Registers OpenTelemetry trace provider
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

  if (!cds._tracer) {
    cds._tracer = trace.getTracer(
      cds.env.requires.otel.trace.name,
      cds.env.requires.otel.trace.version
    )
  }

  require('./tracing')()

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

  require('./metrics')()
}
