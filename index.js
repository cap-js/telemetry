const cds = require('@sap/cds')

const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { HdbInstrumentation } = require('@sap/opentelemetry-instrumentation-hdb')

// REVISIT: should not be necessary
if (!cds.env.trace) cds.env.trace = {}

module.exports = {
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingPaths: cds.env.trace.ignorePaths }),
    new ExpressInstrumentation({ ignoreLayersType: cds.env.trace.ignoreExpressLayer }),
    new HdbInstrumentation()
  ]
}
