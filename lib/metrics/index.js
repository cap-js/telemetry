const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { metrics } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')

const { _require } = require('../utils')

function _getExporter() {
  const metricsExporter = cds.env.requires.telemetry.metrics.exporter
  // use _require for better error message
  const metricsExporterModule =
    metricsExporter.module === '@cap-js/opentelemetry-instrumentation'
      ? require('../exporter')
      : _require(metricsExporter.module)
  if (!metricsExporterModule[metricsExporter.class])
    throw new Error(`Unknown metrics exporter "${metricsExporter.class}" in module "${metricsExporter.module}"`)
  const metricsConfig = { ...(metricsExporter.config || {}) }
  // REVISIT: some dyntrace stuff
  const dynatrace = process.env.VCAP_SERVICES && 'dynatrace' in JSON.parse(process.env.VCAP_SERVICES)
  if (dynatrace) {
    metricsConfig.url = metricsConfig.url ?? `${dynatrace.apiurl}/v2/otlp/v1/metrics`
    metricsConfig.headers = metricsConfig.headers ?? {}
    metricsConfig.headers.authorization = metricsConfig.headers.authorization ?? `Api-Token ${dynatrace.metrics_token}`
    metricsConfig.temporalityPreference =
      metricsConfig.temporalityPreference ?? require('@opentelemetry/sdk-metrics').AggregationTemporality.DELTA
  }
  const exporter = new metricsExporterModule[metricsExporter.class](metricsConfig)
  LOG._debug && LOG.debug('Using metrics exporter:', exporter)
  return exporter
}

module.exports = resource => {
  /*
   * general setup
   */
  const metricsConfig = cds.env.requires.telemetry.metrics.config
  const exporter = _getExporter()
  const metricReader = new PeriodicExportingMetricReader(Object.assign({}, metricsConfig, { exporter }))

  // REVISIT: get the Dynatrace metadata for entity-awareness
  let dtmetadata = new Resource({})
  for (let name of [
    'dt_metadata_e617c525669e072eebe3d0f08212e8f2.json',
    '/var/lib/dynatrace/enrichment/dt_metadata.json'
  ]) {
    try {
      LOG.info(`Reading dtmetadata "${name}" ...`)
      const content = fs.readFileSync(name.startsWith('/var') ? name : fs.readFileSync(name).toString('utf-8').trim()).toString('utf-8')
      LOG.info('Content:', content)
      dtmetadata = dtmetadata.merge(new Resource(JSON.parse(content)))
      break
    } catch (err) {
      LOG.info('Failed with error:', err)
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
