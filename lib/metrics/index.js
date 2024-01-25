const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { metrics } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')

const { getDynatraceCredentials, getCloudLoggingCredentials, _require } = require('../utils')

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
    const token = dynatrace.otel_apitoken || dynatrace.metrics_apitoken || dynatrace.rest_apitoken?.token
    if (!token) throw new Error('Neither otel_apitoken, metrics_apitoken nor rest_apitoken.token found in Dynatrace credentials')
    metricsConfig.headers.authorization ??= `Api-Token ${token}`
    metricsConfig.temporalityPreference ??= require('@opentelemetry/sdk-metrics').AggregationTemporality.DELTA
  }

  const clc = getCloudLoggingCredentials()
  if (clc && cds.env.requires.telemetry.kind.match(/cloud-logging/)) {
    metricsConfig.url ??= clc.url
    metricsConfig.credentials ??= clc.credentials
  }

  const exporter = new metricsExporterModule[metricsExporter.class](metricsConfig)
  LOG._debug && LOG.debug('Using metrics exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.metrics?.exporter) return

  /*
   * general setup
   */
  const metricsConfig = cds.env.requires.telemetry.metrics.config
  const exporter = _getExporter()
  const metricReader = new PeriodicExportingMetricReader(Object.assign({}, metricsConfig, { exporter }))

  let dtmetadata = new Resource({})
  for (let name of [
    'dt_metadata_e617c525669e072eebe3d0f08212e8f2.json',
    '/var/lib/dynatrace/enrichment/dt_metadata.json'
  ]) {
    try {
      LOG._debug && LOG.debug(`Trying to read dtmetadata source "${name}" ...`)
      const content = fs
        .readFileSync(name.startsWith('/var') ? name : fs.readFileSync(name).toString('utf-8').trim())
        .toString('utf-8')
      LOG._debug && LOG.debug('Successful')
      dtmetadata = dtmetadata.merge(new Resource(JSON.parse(content)))
      break
    } catch (err) {
      LOG._debug && LOG.debug('Failed with error:', err)
    }
  }

  const meterProvider = new MeterProvider({ resource: new Resource({}).merge(resource).merge(dtmetadata) })
  meterProvider.addMetricReader(metricReader)
  metrics.setGlobalMeterProvider(meterProvider)

  /*
   * add individual metrics
   */
  require('./db-pool')()
}
