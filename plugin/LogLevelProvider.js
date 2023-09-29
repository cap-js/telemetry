const cds = require('@sap/cds')
const LOG = cds.log('trace')
const { DiagLogLevel } = require('@opentelemetry/api')

/**
 * Maps cds log level for logger trace to Diag log levels
 */
function getLogLevel() {
  if (process.env.OTEL_LOG_LEVEL) return DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase()]
  if (LOG._trace) return DiagLogLevel.VERBOSE
  else if (LOG._debug) return DiagLogLevel.DEBUG
  else if (LOG._info) return DiagLogLevel.INFO
  else if (LOG._warn) return DiagLogLevel.WARN
  else if (LOG._error) return DiagLogLevel.ERROR
  else return DiagLogLevel.NONE
}

module.exports = { getLogLevel }
