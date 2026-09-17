const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { DiagLogLevel } = require('@opentelemetry/api')

function getDiagLogLevel() {
  if (process.env.OTEL_LOG_LEVEL) {
    let level = Number(process.env.OTEL_LOG_LEVEL)
    if (Number.isInteger(level)) return level
    level = DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase()]
    if (!level) LOG.warn(`Unknown OTEL_LOG_LEVEL value: "${process.env.OTEL_LOG_LEVEL}", defaulting to "INFO"`)
    return level ?? DiagLogLevel.INFO
  }

  if (LOG._trace) return DiagLogLevel.VERBOSE
  if (LOG._debug) return DiagLogLevel.DEBUG
  if (LOG._info) return DiagLogLevel.INFO
  if (LOG._warn) return DiagLogLevel.WARN
  if (LOG._error) return DiagLogLevel.ERROR
  return DiagLogLevel.NONE
}

let PKG
function hasDependency(name) {
  if (!PKG) {
    try {
      PKG = require(cds.root + '/package.json')
    } catch (err) {
      LOG._info && LOG.info(`Unable to require package.json to check for dependency "${name}" due to error:`, err)
      return false
    }
  }
  return !!PKG.dependencies[name]
}

function _require(name) {
  name = Array.isArray(name) ? name[0] : name
  try {
    return require(name.startsWith('./') ? cds.utils.path.join(cds.root, name) : name)
  } catch (err) {
    err.message = `Cannot find module '${name}'. Make sure to install it with 'npm i ${name}'\n` + err.message
    throw err
  }
}

module.exports = {
  getDiagLogLevel,
  hasDependency,
  _require
}
