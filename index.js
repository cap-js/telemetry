const cds = require('@sap/cds')

const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')

module.exports = {
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingPaths: cds.env.requires.otel.trace.ignorePaths }), //> REVISIT: why not use config name of third party?
    new ExpressInstrumentation({ ignoreLayersType: cds.env.requires.otel.trace.ignoreExpressLayer }), //> REVISIT: why not use config name of third party?
  ]
}