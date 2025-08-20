const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { metrics } = require('@opentelemetry/api')
const { getStringFromEnv } = require('@opentelemetry/core')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  AggregationTemporality,
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader
} = require('@opentelemetry/sdk-metrics')

const { getDynatraceMetadata, getCredsForDTAsUPS, getCredsForCLSAsUPS, augmentCLCreds, _require } = require('../utils')

const _protocol2module = {
  'grpc': '@opentelemetry/exporter-metrics-otlp-grpc',
  'http/protobuf': '@opentelemetry/exporter-metrics-otlp-proto',
  'http/json': '@opentelemetry/exporter-metrics-otlp-http'
}

function _getExporter() {
  let {
    kind,
    metrics: { exporter: metricsExporter },
    credentials
  } = cds.env.requires.telemetry

  if (metricsExporter === 'env') { // ... process env to determine exporter module to use
    let protocol = getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')
    
    if (!protocol) {
      // > On kyma, the otlp endpoint speaks grpc, but otel's default protocol is http/protobuf -> fix default
      const endpoint = (getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT') ?? '')
      if (endpoint.match(/:4317/)) protocol = 'grpc'
    }

    protocol ??= (getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL'))
    metricsExporter = { module: _protocol2module[protocol], class: 'OTLPMetricExporter' }
  }

  // Import the configured exporter module > use _require for better error message
  const metricsExporterModule = metricsExporter.module === '@cap-js/telemetry' 
    ? require('../exporter') 
    : _require(metricsExporter.module)
  if (!metricsExporterModule[metricsExporter.class])
    throw new Error(`Unknown metrics exporter "${metricsExporter.class}" in module "${metricsExporter.module}"`)
  
  const config = { ...(metricsExporter.config || {}) }
  config.temporalityPreference ??= AggregationTemporality.DELTA

  // Augment configruation depending on 'kind' of telementry
  if (kind.match(/to-dynatrace$/)) {
    if (!credentials) credentials = getCredsForDTAsUPS()
    if (!credentials) throw new Error('No Dynatrace credentials found.')
    
    config.url ??= `${credentials.apiurl}/v2/otlp/v1/metrics`
    config.headers ??= {}
    
    // Extract REST API token from credentials to configure auth:
    // > 'metrics_apitoken' for compatibility with previous releases
    // > 'credentials.rest_apitoken?.token' is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    const token = credentials[token_name] || credentials.metrics_apitoken || credentials.rest_apitoken?.token
    if (!token) throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)
    
    config.headers.authorization ??= `Api-Token ${token}`
  }

  if (kind.match(/to-cloud-logging$/)) {
    if (!credentials) credentials = getCredsForCLSAsUPS()
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found.')
    
    augmentCLCreds(credentials)
    
    config.url ??= credentials.url
    config.credentials ??= credentials.credentials
  }

  const exporter = new metricsExporterModule[metricsExporter.class](config)
  LOG._debug && LOG.debug('Using metrics exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.metrics?.exporter) return

  /*
   * general setup
   */
  const metricsConfig = cds.env.requires.telemetry.metrics.config
  let exporter = _getExporter()
  
  if (typeof exporter.export === 'function') {
    // In case export is a function to be called by this runtime (push):
    // > The exporter needs to be wrappeed thus, to set an export interval
    exporter = new PeriodicExportingMetricReader({ ...metricsConfig, exporter })
  }

  let meterProvider = metrics.getMeterProvider()
  if (meterProvider.constructor.name === 'NoopMeterProvider') {
    const dtmetadata = getDynatraceMetadata()
    resource = resourceFromAttributes({}).merge(resource).merge(dtmetadata)
    // unfortunately, we have to pass views to the MeterProvider constructor
    // something like meterProvider.addView() would be a lot nicer for locality
    let views = []
    if (process.env.HOST_METRICS_RETAIN_SYSTEM) {
      // nothing to do
    } else {
      views.push({
        meterName: '@cap-js/telemetry:host-metrics',
        instrumentName: 'system.*',
        aggregation: {
          type: AggregationType.DROP
        }
      })
    }
    meterProvider = new MeterProvider({ resource, readers: [exporter], views })
    metrics.setGlobalMeterProvider(meterProvider)
  } else {
    // TODO: CALM
    LOG._warn && LOG.warn('MeterProvider already initialized by a different module. It will be used as is.')
  }

  /*
   * add individual metrics
   */
  require('./db-pool')()
  require('./queue')()
  require('./host')()

  return meterProvider
}
