const cds = require('@sap/cds')
const LOG = cds.log('cds')
const APPLOG = cds.log('app')

// REVISIT: why not cds.Service, cds.ApplicationService, etc.?
const Service = require('@sap/cds/lib/srv/srv-api')
const ApplicationService = require('@sap/cds/libx/_runtime/cds-services/services/Service')
const DatabaseService = require('@sap/cds/libx/_runtime/db/Service')

const trace = require('./trace')
const wrap = require('./wrapper')

function wrapEventHandler(eventHandler) {
  const phase = eventHandler.on ? 'on' : eventHandler.before ? 'before' : 'after'
  eventHandler.handler = wrap(eventHandler.handler, {
    loggerName: APPLOG.label,
    phase: phase,
    event: eventHandler[phase]
  })
}

module.exports = () => {
  const { emit } = Service.prototype

  // Specific wrapping favoured to have more flexibility when unwrapping
  /*
  Service.prototype.handle = wrap(handle, {
    wrapper: function (req) {
     return trace(handle, this, req.phase, req.event, arguments);
    }
  })
  */
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
    // Do trace event handler either when
    // Logging is enabled for all and it is not explicitly  disabled for this service
    // Or tracing is explicitly enabled and the general setting is not silent
    if (
      (APPLOG._trace && service.definition['@cds.tracing'] !== false) ||
      (service.definition['@cds.tracing'] && APPLOG.level !== 0)
    ) {
      for (const each of ['_error', '_initial', 'on', 'before', 'after'])
        service._handlers[each].forEach(wrapEventHandler)
    }

    // If tracing is explicitly disabled for this service
    // Or if tracing in general is disabled for services and not explicitly enabled for this one
    // Remove tracing
    if ((!LOG._info && service.definition['@cds.tracing'] !== true) || service.definition['@cds.tracing'] === false) {
      service.emit = service.emit.__original
      service.handle = service.handle.__original
    }
  })

  // REVISIT: Does it also work with cds.context.spawn?
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