const cds = require('@sap/cds')
// const LOG = cds.log('otel')

const fs = require('fs')

const { diag, DiagConsoleLogger } = require('@opentelemetry/api')

const { getDiagLogLevel, getResource } = require('./utils')

module.exports = function () {
  diag.setLogger(new DiagConsoleLogger(), getDiagLogLevel())

  /**
   * Registers OpenTelemetry trace provider
   */
  // REVISIT: Determine app name and version via package.json
  cds.env.requires.otel.trace.name = 'CAP Application'
  cds.env.requires.otel.trace.version = 1.0
  if (fs.existsSync(cds.env._home + '/package.json')) {
    const pack = JSON.parse(fs.readFileSync(cds.env._home + '/package.json', 'utf8'))
    cds.env.requires.otel.trace.name = pack.name
    cds.env.requires.otel.trace.version = pack.version
  }

  const resource = getResource()

  /*
   * add tracing
   */
  require('./tracing')(resource)

  /*
   * add metrics
   */
  require('./metrics')(resource)
}
