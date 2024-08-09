const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { metrics } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const {
  AggregationTemporality,
  DropAggregation,
  MeterProvider,
  PeriodicExportingMetricReader,
  View
} = require('@opentelemetry/sdk-metrics')

const { getDynatraceMetadata, getCredsForDTAsUPS, getCredsForCLSAsUPS, augmentCLCreds, _require } = require('../utils')

function _getExporter() {
  let {
    kind,
    metrics: { exporter: metricsExporter },
    credentials
  } = cds.env.requires.telemetry

  // use _require for better error message
  const metricsExporterModule =
    metricsExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(metricsExporter.module)
  if (!metricsExporterModule[metricsExporter.class])
    throw new Error(`Unknown metrics exporter "${metricsExporter.class}" in module "${metricsExporter.module}"`)
  const metricsConfig = { ...(metricsExporter.config || {}) }

  if (kind.match(/dynatrace/)) {
    if (!credentials) credentials = getCredsForDTAsUPS()
    if (!credentials) throw new Error('No Dynatrace credentials found.')
    metricsConfig.url ??= `${credentials.apiurl}/v2/otlp/v1/metrics`
    metricsConfig.headers ??= {}
    // credentials.rest_apitoken?.token is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    // metrics_apitoken for compatibility with previous releases
    const token = credentials[token_name] || credentials.metrics_apitoken || credentials.rest_apitoken?.token
    if (!token)
      throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)
    metricsConfig.headers.authorization ??= `Api-Token ${token}`
  }

  if (kind.match(/cloud-logging/)) {
    if (!credentials) credentials = getCredsForCLSAsUPS()
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found.')
    augmentCLCreds(credentials)
    metricsConfig.url ??= credentials.url
    metricsConfig.credentials ??= credentials.credentials
  }

  // default to DELTA
  metricsConfig.temporalityPreference ??= AggregationTemporality.DELTA

  const exporter = new metricsExporterModule[metricsExporter.class](metricsConfig)
  LOG._debug && LOG.debug('Using metrics exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.metrics?.exporter) return

  /*
   * general setup
   */
  let meterProvider = metrics.getMeterProvider()
  if (meterProvider.constructor.name === 'NoopMeterProvider') {
    const dtmetadata = getDynatraceMetadata()
    resource = new Resource({}).merge(resource).merge(dtmetadata)
    // unfortunately, we have to pass views to the MeterProvider constructor
    // something like meterProvider.addView() would be a lot nicer for locality
    let views = []
    if (process.env.HOST_METRICS_RETAIN_SYSTEM) {
      // nothing to do
    } else {
      views.push(
        new View({
          meterName: '@cap-js/telemetry:host-metrics',
          instrumentName: 'system.*',
          aggregation: new DropAggregation()
        })
      )
    }
    meterProvider = new MeterProvider({ resource, views })
    metrics.setGlobalMeterProvider(meterProvider)
  } else {
    LOG._warn && LOG.warn('MeterProvider already initialized by a different module. It will be used as is.')
  }

  const metricsConfig = cds.env.requires.telemetry.metrics.config
  const exporter = _getExporter()
  // push vs. pull
  if (typeof exporter.export === 'function') {
    const metricReader = new PeriodicExportingMetricReader({ ...metricsConfig, exporter })
    meterProvider.addMetricReader(metricReader)
  } else {
    meterProvider.addMetricReader(exporter)
  }

  /*
   * add individual metrics
   */
  require('./db-pool')()
  require('./host')()

  return meterProvider
}
