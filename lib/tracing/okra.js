const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const locate = require('./locate')
const trace = require('./trace')

module.exports = () => {
  let OKRAService
  try {
    OKRAService = require('@sap/cds/libx/_runtime/cds-services/adapter/odata-v4/okra/odata-server/core/Service')
  } catch (err) {
    LOG._warn && LOG.warn('Unable to instrument Okra due to error:', err)
    return
  }

  const { process: _process } = OKRAService.prototype

  const NO_LOCATE = process.env.NO_LOCATE || cds.env.requires.telemetry.tracing.no_locate
  if (!NO_LOCATE) {
    let __location
    locate(_process).then(location => {
      __location = location
    })
    Object.defineProperty(_process, '__location', {
      get: function () {
        return __location
      }
    })
  }

  OKRAService.prototype.process = function (request) {
    if (!request._ctx && cds.context) request._ctx = cds.context
    if (!cds.context) cds.context = request?._batchContext?._incomingODataRequest?._inRequest?._ctx
    return trace(`${request.method} ${request.url}`, _process, this, arguments)
  }
}
