const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { metrics } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { DropAggregation, MeterProvider, PeriodicExportingMetricReader, View } = require('@opentelemetry/sdk-metrics')

const { getDynatraceMetadata, getDynatraceCredentials, getCloudLoggingCredentials, _require } = require('../utils')

function _getExporter() {
  const metricsExporter = cds.env.requires.telemetry.metrics.exporter
  // use _require for better error message
  const metricsExporterModule =
    metricsExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(metricsExporter.module)
  if (!metricsExporterModule[metricsExporter.class])
    throw new Error(`Unknown metrics exporter "${metricsExporter.class}" in module "${metricsExporter.module}"`)
  const metricsConfig = { ...(metricsExporter.config || {}) }

  const dynatrace = getDynatraceCredentials()
  if (dynatrace && cds.env.requires.telemetry.kind.match(/dynatrace/)) {
    metricsConfig.url ??= `${dynatrace.apiurl}/v2/otlp/v1/metrics`
    metricsConfig.headers ??= {}
    // dynatrace.rest_apitoken?.token is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    // metrics_apitoken for compatibility with previous releases
    const token = dynatrace[token_name] || dynatrace.metrics_apitoken || dynatrace.rest_apitoken?.token
    if (!token)
      throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)
    metricsConfig.headers.authorization ??= `Api-Token ${token}`
  }

  const clc = getCloudLoggingCredentials()
  if (clc && cds.env.requires.telemetry.kind.match(/cloud-logging/)) {
    metricsConfig.url ??= clc.url
    metricsConfig.credentials ??= clc.credentials
  }

  // default to DELTA
  metricsConfig.temporalityPreference ??= require('@opentelemetry/sdk-metrics').AggregationTemporality.DELTA

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
  const metricReader = new PeriodicExportingMetricReader({ ...metricsConfig, exporter })
  meterProvider.addMetricReader(metricReader)

  /*
   * add individual metrics
   */
  require('./db-pool')()
  require('./host')()
}
