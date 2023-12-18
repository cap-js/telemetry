const cds = require('@sap/cds')
const LOG = cds.log('cds')
const APPLOG = cds.log('app')

const trace = require('./trace')
const wrap = require('./wrap')

function _wrapHandler(handler) {
  const phase = handler.on ? 'on' : handler.before ? 'before' : 'after'
  handler.handler = wrap(handler.handler, {
    // loggerName: APPLOG.label,
    phase: phase,
    event: handler[phase]
  })
}

const _wrapStmt = (stmt, impl, sql) => {
  for (const fn of ['run', 'get', 'all', 'stream', 'runBatch']) {
    if (!stmt[fn]) continue
    const it = stmt[fn]
    stmt[fn] = wrap(it, {
      no_locate: true,
      wrapper: function () {
        return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments /*, { loggerName: LOG.label }*/)
      }
    })
  }
  return stmt
}

module.exports = () => {
  const { emit, handle } = cds.Service.prototype
  cds.Service.prototype.emit = wrap(emit, {
    wrapper: function () {
      const event = arguments[0]?.event || arguments[0]
      return trace({ phase: 'emit', event }, emit, this, arguments /*, { loggerName: LOG.label }*/)
    }
  })
  cds.Service.prototype.handle = wrap(handle, {
    wrapper: function (req) {
      if (!cds.env.requires.telemetry.tracing.tx && req.event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
        return handle.apply(this, arguments)
      return trace(req, handle, this, arguments /*, { loggerName: LOG.label }*/)
    }
  })

  const { spawn } = cds
  cds.spawn = wrap(spawn, {
    wrapper: function () {
      const handlerFn = typeof arguments[0] === 'function' ? arguments[0] : arguments[1]
      const wrappedFn = wrap(handlerFn, { event: 'cds.spawn Handler'/* , loggerName: LOG.label */ })
      if (typeof arguments[0] === 'function') arguments[0] = wrappedFn
      else arguments[1] = wrappedFn
      return trace({ phase: '', event: 'Background Process' }, spawn, this, arguments /*, { loggerName: LOG.label }*/)
    }
  })

  cds.on('serving', service => {
    // Do trace event handler either when
    // Logging is enabled for all and it is not explicitly  disabled for this service
    // Or tracing is explicitly enabled and the general setting is not silent
    if (
      cds.env.requires.telemetry.tracing?.level === 'debug' ||
      (APPLOG._trace && service.definition['@cds.tracing'] !== false) ||
      (service.definition['@cds.tracing'] && APPLOG.level !== 0)
    ) {
      for (const each of ['_error', '_initial', 'on', 'before', 'after']) {
        service._handlers[each].forEach(_wrapHandler)
      }
    }

    // If tracing is explicitly disabled for this service
    // Or if tracing in general is disabled for services and not explicitly enabled for this one
    // Remove tracing
    if ((!LOG._info && service.definition['@cds.tracing'] !== true) || service.definition['@cds.tracing'] === false) {
      service.emit = service.emit.__original
      service.handle = service.handle.__original
    }
  })

  const impl = cds.env.requires.db?.impl
  if (impl?.match(/^@cap-js\//)) {
    const dbService = require(impl)
    cds.once('served', () => {
      const { prepare, exec } = dbService.prototype
      dbService.prototype.prepare = wrap(prepare, {
        wrapper: function (sql) {
          const stmt = trace(`${impl} - prepare ${sql}`, prepare, this, arguments /*, { loggerName: LOG.label }*/)
          if (stmt instanceof Promise) return stmt.then(stmt => _wrapStmt(stmt, impl, sql))
          return _wrapStmt(stmt, impl, sql)
        }
      })
      dbService.prototype.exec = wrap(exec, {
        wrapper: function (sql) {
          if (!cds.env.requires.telemetry.tracing.tx && sql in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
            return exec.apply(this, arguments)
          return trace(`${impl} - exec ${sql}`, exec, this, arguments /*, { loggerName: LOG.label }*/)
        }
      })
    })
  }
}
