const cds = require('@sap/cds')
const LOG = cds.log('cds')
const APPLOG = cds.log('app')

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
  const { emit: srvEmit } = cds.Service.prototype
  cds.Service.prototype.emit = wrap(srvEmit, {
    wrapper: function () {
      const event = arguments[0]?.event || arguments[0]
      return trace({ phase: 'emit', event }, srvEmit, this, arguments, { loggerName: LOG.label })
    }
  })

  const { handle: srvHandle } = cds.Service.prototype
  cds.Service.prototype.handle = wrap(srvHandle, {
    wrapper: function (req) {
      if (!cds.env.requires.telemetry.tracing.tx && req.event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
        return srvHandle.apply(this, arguments)
      return trace(req, srvHandle, this, arguments, { loggerName: LOG.label })
    }
  })

  if (cds.env.requires.db?.impl?.match(/^@cap-js\//)) {
    const impl = cds.env.requires.db.impl
    const db = require(impl)

    cds.once('served', () => {
      const { prepare, exec } = db.prototype
      db.prototype.prepare = wrap(prepare, {
        wrapper: function (sql) {
          return trace(`${impl} - prepare ${sql}`, prepare, this, arguments, { loggerName: LOG.label }).then(stmt => {
            for (const fn of ['run', 'get', 'all', 'stream', 'runBatch']) {
              if (!stmt[fn]) continue
              const it = stmt[fn]
              stmt[fn] = wrap(it, {
                wrapper: function () {
                  return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments, { loggerName: LOG.label })
                }
              })
            }
            return stmt
          })
        }
      })
      db.prototype.exec = wrap(exec, {
        wrapper: function (sql) {
          return trace(`${impl} - exec ${sql}`, exec, this, arguments, { loggerName: LOG.label })
        }
      })
    })

    // for (const fn of ['onSELECT', 'onINSERT', 'onUPSERT', 'onUPDATE', 'onDELETE', 'onSIMPLE', 'onEVENT', 'onSTREAM', 'onPlainSQL']) {
    //   if (!db.prototype[fn]) continue
    //   const it = db.prototype[fn]
    //   db.prototype[fn] = wrap(it, {
    //     wrapper: function (sql) {
    //       return trace(`${impl} - ${sql}`, it, this, arguments, { loggerName: LOG.label })
    //     }
    //   })
    // }
  }

  cds.on('serving', service => {
    // Do trace event handler either when
    // Logging is enabled for all and it is not explicitly  disabled for this service
    // Or tracing is explicitly enabled and the general setting is not silent
    if (
      cds.env.requires.telemetry.tracing?.level === 'debug' ||
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
