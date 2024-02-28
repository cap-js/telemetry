const { diag } = require('@opentelemetry/api')

const tracing = require('./tracing')
const metrics = require('./metrics')
const { getDiagLogLevel, getResource } = require('./utils')

module.exports = function () {
  // set logger and propagate log level
  diag.setLogger(cds.log('telemetry'), process.env.OTEL_LOG_LEVEL || getDiagLogLevel())

  const resource = getResource()

  // REVISIT: better way to make available?
  cds._telemetry = {
    name: resource.attributes['service.name'],
    version: resource.attributes['service.version']
  }
  /*
   * add anounymous health endpoint - required for Kyma
   */
  cds.on('bootstrap', app => {
    app.get('/health', (_, res) => {
      res.status(200).send('OK')
    });
  });

  /*
   * add tracing
   */
  tracing(resource)

  /*
   * add metrics
   */
  metrics(resource)
}
