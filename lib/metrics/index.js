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

const { getDynatraceMetadata, getCredsForDTAsUPS, getCredsForCLSAsUPS, getCredsForCaaS, augmentCLCreds, augmentCaaSCreds, _require } = require('../utils')

const _protocol2module = {
  grpc: '@opentelemetry/exporter-metrics-otlp-grpc',
  'http/protobuf': '@opentelemetry/exporter-metrics-otlp-proto',
  'http/json': '@opentelemetry/exporter-metrics-otlp-http'
}

function _getExporter() {
  let {
    kind,
    metrics: { exporter: metricsExporter },
    credentials
  } = cds.env.requires.telemetry

  if (metricsExporter === 'env') {
    // ... process env to determine exporter module to use
    let protocol =
      getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')

    if (!protocol) {
      // > On kyma, the otlp endpoint speaks grpc, but otel's default protocol is http/protobuf -> fix default
      const endpoint =
        getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT') ?? ''
      if (endpoint.match(/:4317/)) protocol = 'grpc'
    }

    protocol ??=
      getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')
    metricsExporter = { module: _protocol2module[protocol], class: 'OTLPMetricExporter' }
  }

  // Import the configured exporter module > use _require for better error message
  const metricsExporterModule =
    metricsExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(metricsExporter.module)
  if (!metricsExporterModule[metricsExporter.class])
    throw new Error(`Unknown metrics exporter "${metricsExporter.class}" in module "${metricsExporter.module}"`)

  const config = { ...(metricsExporter.config || {}) }
  config.temporalityPreference ??= AggregationTemporality.DELTA

  // Augment configuration depending on 'kind' of telemetry
  if (kind.match(/to-dynatrace$/)) {
    if (!credentials) credentials = getCredsForDTAsUPS()
    if (!credentials) throw new Error('No Dynatrace credentials found. Make sure the bound service instance uses the tag "dynatrace".')
    config.url ??= `${credentials.apiurl}/v2/otlp/v1/metrics`
    config.headers ??= {}

    // Extract REST API token from credentials to configure auth:
    // > 'metrics_apitoken' for compatibility with previous releases
    // > 'credentials.rest_apitoken?.token' is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    const token = credentials[token_name] || credentials.metrics_apitoken || credentials.rest_apitoken?.token
    if (!token)
      throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)

    config.headers.authorization ??= `Api-Token ${token}`
  }

  if (kind.match(/to-cloud-logging$/)) {
    if (!credentials) credentials = getCredsForCLSAsUPS()
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found. Make sure the bound service instance uses the tag "Cloud Logging".')
    augmentCLCreds(credentials)

    config.url ??= credentials.url
    config.credentials ??= credentials.credentials
  }

  if (kind.match(/to-caas$/)) {
    if (!credentials) credentials = getCredsForCaaS()
    if (!credentials) throw new Error('No CaaS credentials found.')
    augmentCaaSCreds(credentials)
    // Append /v1/metrics to base URL (OTLP exporter expects full URL when config.url is provided)
    config.url ??= credentials.baseUrl ? credentials.baseUrl + '/v1/metrics' : credentials.url + '/v1/metrics'
    // Pass mTLS agent options if available (OTLP exporter uses 'httpAgentOptions')
    if (credentials.httpAgentOptions) {
      config.httpAgentOptions = credentials.httpAgentOptions
      LOG._info && LOG.info('CaaS metrics exporter config: url=' + config.url + ', httpAgentOptions.cert exists=' + !!config.httpAgentOptions.cert)
    } else {
      LOG._warn && LOG.warn('CaaS metrics: no httpAgentOptions found in credentials')
    }
  }

  const exporter = new metricsExporterModule[metricsExporter.class](config)
  LOG._debug && LOG.debug('Using metrics exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.metrics?.exporter) return

  /*
   * add individual metrics
   */
  require('./db-pool')()
  require('./queue')()

  /*
   * create reader
   */
  const metricsConfig = cds.env.requires.telemetry.metrics.config
  let reader = _getExporter()
  if (typeof reader.export === 'function') {
    // In case export is a function to be called by this runtime (push):
    // > The exporter needs to be wrapped thus, to set an export interval
    reader = new PeriodicExportingMetricReader({ ...metricsConfig, exporter: reader })
  }

  /*
   * either add reader as delegate in CALM...
   */
  if (!resource) {
    LOG.warn("@sap/xotel-agent-ext-js found, adding @cap-js/telemetry's metric reader as delegate")
    try {
      const { getCompositeMetricReader } = require('@sap/xotel-agent-ext-js')
      getCompositeMetricReader().addDelegate(reader)
      return
    } catch (error) {
      LOG.error('Failed to add metric reader as delegate:', error)
      throw error
    }
  }

  /*
   * ... or initialize and return provider
   */
  const dtmetadata = getDynatraceMetadata()
  resource = resourceFromAttributes({}).merge(resource).merge(dtmetadata)
  const meterProvider = new MeterProvider({ resource, readers: [reader] })
  metrics.setGlobalMeterProvider(meterProvider)
  return meterProvider
}
