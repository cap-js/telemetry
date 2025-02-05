const cds = require('@sap/cds')

const { SpanKind } = require('@opentelemetry/api')

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
        return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments, { sql, fn, kind: SpanKind.CLIENT })
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
      const wrappedFn = wrap(handlerFn, { event: 'cds.spawn', kind: SpanKind.CONSUMER })
      if (typeof arguments[0] === 'function') arguments[0] = wrappedFn
      else arguments[1] = wrappedFn
      return trace('cds.spawn', _spawn, this, arguments, { kind: SpanKind.PRODUCER })
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

  cds.on('connect', service => {
    if (service instanceof cds.MessagingService) {
      const unboxed = cds.unboxed(service)
      const { handle: _unboxed_handle } = unboxed
      unboxed.handle = wrap(_unboxed_handle, {
        wrapper: function handle(msg) {
          if (msg.inbound) return _unboxed_handle.apply(this, arguments)
          const kind = service.kind !== 'local-messaging' ? SpanKind.PRODUCER : SpanKind.INTERNAL
          return trace(msg, _unboxed_handle, this, arguments, { kind })
        }
      })
    }
  })

  const impl = cds.env.requires.db?.impl
  if (impl?.match(/^@cap-js\//)) {
    const dbService = require(impl)
    cds.once('served', () => {
      const { prepare: _prepare, exec: _exec } = dbService.prototype
      dbService.prototype.prepare = wrap(_prepare, {
        wrapper: function prepare(sql) {
          const stmt = trace(`${impl} - prepare ${sql}`, _prepare, this, arguments, {
            sql,
            fn: 'prepare',
            kind: SpanKind.CLIENT
          })
          if (stmt instanceof Promise) return stmt.then(stmt => _wrapStmt(stmt, impl, sql))
          return _wrapStmt(stmt, impl, sql)
        }
      })
      dbService.prototype.exec = wrap(_exec, {
        wrapper: function exec(sql) {
          if (!cds.env.requires.telemetry.tracing._tx && sql in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 })
            return _exec.apply(this, arguments)
          return trace(`${impl} - exec ${sql}`, _exec, this, arguments, { sql, fn: 'exec', kind: SpanKind.CLIENT })
        }
      })
    })
  }
}
