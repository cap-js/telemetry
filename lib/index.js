const cds = require('@sap/cds')

const { diag } = require('@opentelemetry/api')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions')

const tracing = require('./tracing')
const metrics = require('./metrics')
const { getDiagLogLevel, getResource, _require } = require('./utils')

function _getInstrumentations() {
  const instrumentations = []
  for (const each of Object.values(cds.env.requires.telemetry.instrumentations)) {
    const module = _require(each.module)
    if (!module[each.class]) throw new Error(`Unknown instrumentation "${each.class}" in module "${each.module}"`)
    instrumentations.push(new module[each.class]({ ...(each.config || {}) }))
  }
  return instrumentations
}

module.exports = function () {
  // set logger and propagate log level
  diag.setLogger(cds.log('telemetry'), process.env.OTEL_LOG_LEVEL || getDiagLogLevel())

  const resource = getResource()

  // REVISIT: better way to make available?
  cds._telemetry = {
    name: resource.attributes[SEMRESATTRS_SERVICE_NAME],
    version: resource.attributes[SEMRESATTRS_SERVICE_VERSION]
  }

  /*
   * setup tracing
   */
  tracing(resource)

  /*
   * setup metrics
   */
  metrics(resource)

  /*
   * register instrumentations
   */
  registerInstrumentations({ instrumentations: _getInstrumentations() })
}
