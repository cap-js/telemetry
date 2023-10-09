const cds = require('@sap/cds')

const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { HdbInstrumentation } = require('@sap/opentelemetry-instrumentation-hdb')

// REVISIT: should not be necessary
if (!cds.env.trace) cds.env.trace = {}

module.exports = {
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingPaths: cds.env.trace.ignorePaths }), //> REVISIT: why not use config name of third party?
    new ExpressInstrumentation({ ignoreLayersType: cds.env.trace.ignoreExpressLayer }), //> REVISIT: why not use config name of third party?
    new HdbInstrumentation()
  ]
}
