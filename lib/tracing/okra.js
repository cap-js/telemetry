const cds = require('@sap/cds')
const LOG = cds.log('cds')

const trace = require('./trace')

module.exports = () => {
  if (!LOG._info) return

  try {
    require.resolve('@sap/cds/libx/_runtime/cds-services/adapter/odata-v4/okra/odata-server/core/Service')
  } catch {
    return
  }

  // Register cds.context has to be set as it is lost in $batch process
  const OKRAService = require('@sap/cds/libx/_runtime/cds-services/adapter/odata-v4/okra/odata-server/core/Service')
  const { process: innerProcess } = OKRAService.prototype
  OKRAService.prototype.process = function (request) {
    if (!request._ctx && cds.context) request._ctx = cds.context
    if (!cds.context) cds.context = request?._batchContext?._incomingODataRequest?._inRequest?._ctx
    return trace(`${request.method} ${request.url}`, innerProcess, this, arguments, { loggerName: LOG.label }) // REVISIT: Name is a bit shitty
  }
}
