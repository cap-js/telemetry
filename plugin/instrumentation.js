const trace = require('./trace')
const cds = require('@sap/cds')
const api = require('@opentelemetry/api')
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')
const LOG = cds.log('cds'),
  APPLOG = cds.log('app'),
  DBLOG = cds.log('db|sqlite')
const Service = require('@sap/cds/lib/srv/srv-api')
const ApplicationService = require('@sap/cds/libx/_runtime/cds-services/services/Service')
const DatabaseService = require('@sap/cds/libx/_runtime/db/Service')
const wrap = require('./wrapper')

module.exports = {
  addInstrumentation,
  _instrument_sqlite,
  _instrument_better_sqlite,
  _instrument_cds_services,
  _instrument_odata
}

/**
 * Adds tracing to cds services
 * and dbs
 */
function addInstrumentation() {
  _instrument_cds_services()
  if (DBLOG._info) {
    _instrument_sqlite(DBLOG.label)
    _instrument_better_sqlite(DBLOG.label)
  }
  _instrument_odata()
  _outbound_http()
}

function _outbound_http() {
  try {
    require.resolve('@sap-cloud-sdk/http-client')
  } catch {
    return
  }
  const cloudSDK = require('@sap-cloud-sdk/http-client')
  const { executeHttpRequest: orgExecuteHttpRequest, executeHttpRequestWithOrigin: orgExecuteHttpRequestWithOrigin } =
    cloudSDK
  cloudSDK.executeHttpRequest = wrap(orgExecuteHttpRequest, {
    wrapper: function (destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        orgExecuteHttpRequest,
        this,
        arguments,
        { loggerName: LOG.label, outbound: destination.name }
      )
    }
  })
  cloudSDK.executeHttpRequestWithOrigin = wrap(orgExecuteHttpRequestWithOrigin, {
    wrapper: function (destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        orgExecuteHttpRequestWithOrigin,
        this,
        arguments,
        { loggerName: LOG.label, outbound: destination.name }
      )
    }
  })
}

function _instrument_cds_services() {
  const { emit } = Service.prototype

  //Specific wrapping favoured to have more flexibility when unwrapping
  /* Service.prototype.handle = wrap(handle, {wrapper: function (req) {
    return trace(handle, this, req.phase, req.event, arguments);
  }}) */
  const { handle: applHandle } = ApplicationService.prototype
  ApplicationService.prototype.handle = wrap(applHandle, {
    wrapper: function (req) {
      return trace(req, applHandle, this, arguments, { loggerName: LOG.label })
    }
  })

  const { handle: dbHandle } = DatabaseService.prototype
  DatabaseService.prototype.handle = wrap(dbHandle, {
    wrapper: function (req) {
      return trace(req, dbHandle, this, arguments, { loggerName: LOG.label })
    }
  })

  Service.prototype.emit = wrap(emit, {
    wrapper: function () {
      const event = arguments[0]?.event || arguments[0]
      return trace({ phase: 'emit', event }, emit, this, arguments, { loggerName: LOG.label })
    }
  })

  cds.on('serving', service => {
    //Do trace event handler either when
    //Logging is enabled for all and it is not explicitly  disabled for this service
    //Or tracing is explicitly enabled and the general setting is not silent
    if (
      (APPLOG._trace && service.definition['@cds.tracing'] !== false) ||
      (service.definition['@cds.tracing'] && APPLOG.level !== 0)
    )
      for (const each of ['_error', '_initial', 'on', 'before', 'after'])
        service._handlers[each].forEach(wrapEventHandler)

    //If tracing is explicitly disabled for this service
    //Or if tracing in general is disabled for services and not explicitly enabled for this one
    //Remove tracing
    if ((!LOG._info && service.definition['@cds.tracing'] !== true) || service.definition['@cds.tracing'] === false) {
      service.emit = service.emit.__original
      service.handle = service.handle.__original
    }
  })

  //Revisit: Does it also work with cds.context.spawn?
  const { spawn: oriSpawn } = cds
  cds.spawn = wrap(oriSpawn, {
    wrapper: function () {
      const handlerFn = typeof arguments[0] === 'function' ? arguments[0] : arguments[1]
      const wrappedFn = wrap(handlerFn, { event: 'cds.spawn Handler', loggerName: LOG.label })
      if (typeof arguments[0] === 'function') arguments[0] = wrappedFn
      else arguments[1] = wrappedFn
      return trace({ phase: '', event: 'Background Process' }, oriSpawn, this, arguments, { loggerName: LOG.label })
    }
  })
}

//srv.emit, cds.spawn, cds.log - check srv.on in case of async

function _instrument_odata() {
  if (!LOG._info) return 
  try {
    require.resolve('@sap/cds/libx/_runtime/cds-services/adapter/odata-v4/okra/odata-server/core/Service')
  } catch {
    return
  }
  //Register cds.context has to be set as it is lost in $batch process
  const OKRAService = require('@sap/cds/libx/_runtime/cds-services/adapter/odata-v4/okra/odata-server/core/Service')
  const { process: innerProcess } = OKRAService.prototype
  OKRAService.prototype.process = function (request) {
    if (!request._ctx && cds.context) request._ctx = cds.context
    if (!cds.context) cds.context = request?._batchContext?._incomingODataRequest?._inRequest?._ctx
    return trace(`${request.method} ${request.url}`, innerProcess, this, arguments, { loggerName: LOG.label }) //REVISIT: Name is a bit shitty
  }
}

function wrapEventHandler(eventHandler) {
  const phase = eventHandler.on ? 'on' : eventHandler.before ? 'before' : 'after'
  eventHandler.handler = wrap(eventHandler.handler, {
    loggerName: APPLOG.label,
    phase: phase,
    event: eventHandler[phase]
  })
}

const skip = { BEGIN: 1, COMMIT: 2, ROLLBACK: 3 }

function _instrument_sqlite() {
  try {
    require.resolve('sqlite3')
  } catch {
    return
  }
  const sqlite = require('sqlite3').Database.prototype
  for (let each of ['all', 'get', 'run', 'prepare']) {
    const _super = sqlite[each]
    sqlite[each] = function (q, ..._) {
      if (!(q in skip)) {
        const span = api.trace.getActiveSpan()
        if (span) span.setAttribute(SemanticAttributes.DB_STATEMENT, q) //REVISIT: When statement is in cds.spawn - error:"Can not execute the operation on ended span" shows up
      }
      return _super.call(this, q, ..._)
    }
  }
}

function _instrument_better_sqlite() {
  try {
    require.resolve('better-sqlite3')
  } catch {
    return
  }
  const sqlite = require('better-sqlite3').prototype
  for (let each of ['exec', 'prepare']) {
    const _super = sqlite[each]
    sqlite[each] = function (q, ..._) {
      if (!(q in skip)) {
        const span = api.trace.getActiveSpan()
        if (span) span.setAttribute(SemanticAttributes.DB_STATEMENT, q)
      }
      return _super.call(this, q, ..._)
    }
  }
}
