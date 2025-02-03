const cds = require('@sap/cds')

const trace = require('./trace')
const wrap = require('./wrap')

function _wrapHandler(handler) {
  const phase = handler.on ? 'on' : handler.before ? 'before' : 'after'
  handler.handler = wrap(handler.handler, {
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
        return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments, { sql, fn, outbound: true })
      }
    })
  }
  return stmt
}

module.exports = () => {
  const { emit: _emit, handle: _handle } = cds.Service.prototype
  cds.Service.prototype.emit = wrap(_emit, {
    wrapper: function emit() {
      const event = arguments[0]?.event || arguments[0]
      return trace({ phase: 'emit', event }, _emit, this, arguments, {})
    }
  })
  cds.Service.prototype.handle = wrap(_handle, {
    wrapper: function handle(req) {
      if (!cds.env.requires.telemetry.tracing._tx && req.event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
        return _handle.apply(this, arguments)
      return trace(req, _handle, this, arguments, {})
    }
  })

  const { spawn: _spawn } = cds
  cds.spawn = wrap(_spawn, {
    wrapper: function spawn() {
      const handlerFn = typeof arguments[0] === 'function' ? arguments[0] : arguments[1]
      const wrappedFn = wrap(handlerFn, { event: 'cds.spawn' })
      if (typeof arguments[0] === 'function') arguments[0] = wrappedFn
      else arguments[1] = wrappedFn
      return _spawn.apply(this, arguments)
    }
  })

  cds.on('serving', service => {
    // trace individual event handlers -> INOFFICIAL!
    if (cds.env.requires.telemetry.tracing?.level === 'debug') {
      for (const each of ['_error', '_initial', 'on', 'before', 'after']) {
        service._handlers[each].forEach(_wrapHandler)
      }
    }
  })

  const impl = cds.env.requires.db?.impl
  if (impl?.match(/^@cap-js\//)) {
    cds.once('served', () => {
      const dbService = cds.db.constructor
      const { prepare: _prepare, exec: _exec } = dbService.prototype
      dbService.prototype.prepare = wrap(_prepare, {
        wrapper: function prepare(sql) {
          const stmt = trace(`${impl} - prepare ${sql}`, _prepare, this, arguments, { sql, fn: 'prepare', outbound: true })
          if (stmt instanceof Promise) return stmt.then(stmt => _wrapStmt(stmt, impl, sql))
          return _wrapStmt(stmt, impl, sql)
        }
      })
      dbService.prototype.exec = wrap(_exec, {
        wrapper: function exec(sql) {
          if (!cds.env.requires.telemetry.tracing._tx && sql in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
            return _exec.apply(this, arguments)
          return trace(`${impl} - exec ${sql}`, _exec, this, arguments, { sql, fn: 'exec', outbound: true })
        }
      })

      if (impl === '@cap-js/hana') {
        // REVISIT: when telemetry and hana are loaded from differen places this doesn't work
        const hanaDriver = require('@cap-js/hana/lib/drivers/base.js')
        const _prom = hanaDriver.prom
        hanaDriver.prom = function (dbc, func) {
          const fn = _prom(dbc, func)
          dbc = dbc._parentConnection || dbc
          const driver = dbc.constructor.name === 'Client' ? 'hdb' : '@sap/hana-client'
          return function prom() {
            return trace(`${driver} - ${func}`, fn, this, arguments, { dbc, fn: func, outbound: true })
          }
        }
      }
    })
  }
}
