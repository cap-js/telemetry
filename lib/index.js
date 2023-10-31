const { diag, DiagConsoleLogger } = require('@opentelemetry/api')

const tracing = require('./tracing')
const metrics = require('./metrics')
const { getDiagLogLevel, getResource } = require('./utils')

module.exports = function () {
  // propagate log level to opentelemetry
  if (!process.env.OTEL_LOG_LEVEL) diag.setLogger(new DiagConsoleLogger(), getDiagLogLevel())

  const resource = getResource()

  /*
   * add tracing
   */
  tracing(resource)

  /*
   * add metrics
   */
  metrics(resource)
}
