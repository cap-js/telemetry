const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

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

const _wrapStmt = (stmt, impl, sql, dbc) => {
  for (const fn of ['run', 'get', 'all', 'stream', 'runBatch']) {
    if (!stmt[fn]) continue
    const it = stmt[fn]
    stmt[fn] = wrap(it, {
      no_locate: true,
      wrapper: function () {
        return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments, { sql, dbc, fn, kind: SpanKind.CLIENT })
      }
    })
  }
  return stmt
}

module.exports = () => {
  const { _tx, _hana_prom, _wrap_hana } = cds.env.requires.telemetry.tracing
  const _TX = { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }

  const { emit: _emit, handle: _handle } = cds.Service.prototype
  cds.Service.prototype.emit = wrap(_emit, {
    wrapper: function emit() {
      const event = arguments[0]?.event || arguments[0]
      return trace({ phase: 'emit', event }, _emit, this, arguments, {})
    }
  })
  cds.Service.prototype.handle = wrap(_handle, {
    wrapper: function handle(req) {
      if (!_tx && req.event in _TX) return _handle.apply(this, arguments)
      return trace(req, _handle, this, arguments, {})
    }
  })

  // Wrap `srv.tx(fn)` and `srv.tx(ctx, fn)` so the entire transactional unit of work is
  // captured as a single span. Variants that just return a tx handle (`srv.tx()`,
  // `srv.tx(ctx)`, `srv.tx(req)`) are passed through unwrapped — there's no callback
  // body to span. This makes the queue worker's two transactions (libx/queue/processing.js:
  // SELECT+UPDATE for the lock, then handle+DELETE for the dispatch) appear as proper
  // root spans instead of each top-level CAP call inside them becoming an orphan root.
  const _tx_proto = cds.Service.prototype.tx
  cds.Service.prototype.tx = wrap(_tx_proto, {
    wrapper: function tx() {
      // Find the function argument (variants 2 and the rare ctx+fn case).
      const fnIdx = typeof arguments[0] === 'function' ? 0 : typeof arguments[1] === 'function' ? 1 : -1
      if (fnIdx < 0) return _tx_proto.apply(this, arguments)
      // If this is a nested .tx() on an already-running tx, the wrapped tx is a no-op
      // (see srv-tx.js: `if (srv.context) return srv`) — don't add a redundant span.
      if (this.context) return _tx_proto.apply(this, arguments)
      const name = `${this.name || 'cds'} - tx`
      return trace(name, _tx_proto, this, arguments, {})
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
    let skip_hana_wrapping
    // force wrapping via `cds.requires.telemetry.tracing._wrap_hana = true` -> INOFFICIAL!
    if (impl === '@cap-js/hana' && _wrap_hana !== true) {
      cds.on('connect', async service => {
        if (service.kind === 'hana') {
          service.factory //> invoke factory getter to load the driver
          skip_hana_wrapping = service._driver?._driver?.isOpenTelemetrySupported
        }
      })
    }
    cds.once('served', () => {
      // HANA
      if (impl === '@cap-js/hana') {
        try {
          // REVISIT: when telemetry and hana are loaded from different places this doesn't work
          const hanaDriver = require('@cap-js/hana/lib/drivers/base.js')

          // driver does instrumentation itself?
          if (skip_hana_wrapping) return

          // wrap promisified HANA driver
          const [major, minor] = require('@cap-js/hana/package.json').version.split('.')
          if (_hana_prom && (major > 1 || (major === 1 && minor >= 7))) {
            const _prom = hanaDriver.prom
            hanaDriver.prom = function (dbc, func) {
              const fn = _prom(dbc, func)
              dbc = dbc._parentConnection || dbc
              return function prom() {
                if (!_tx && func.toUpperCase() in _TX) return fn.apply(this, arguments)
                return trace(`@cap-js/hana - ${func}`, fn, this, arguments, { dbc, fn: func, kind: SpanKind.CLIENT })
              }
            }
            return
          }
        } catch (err) {
          LOG._warn && LOG.warn('Failed to wrap hana driver due to error:', err)
        }
      }

      // other DBs (or non-promisified HANA driver)
      const dbService = cds.db.constructor
      const { prepare: _prepare, exec: _exec } = dbService.prototype
      dbService.prototype.prepare = wrap(_prepare, {
        wrapper: function prepare(sql) {
          const stmt = trace(`${impl} - prepare ${sql}`, _prepare, this, arguments, {
            sql,
            fn: 'prepare',
            kind: SpanKind.CLIENT
          })
          if (stmt instanceof Promise) return stmt.then(stmt => _wrapStmt(stmt, impl, sql, this.dbc))
          return _wrapStmt(stmt, impl, sql, this.dbc)
        }
      })
      dbService.prototype.exec = wrap(_exec, {
        wrapper: function exec(sql) {
          if (!_tx && sql in _TX) return _exec.apply(this, arguments)
          return trace(`${impl} - exec ${sql}`, _exec, this, arguments, { sql, fn: 'exec', kind: SpanKind.CLIENT })
        }
      })
    })
  }
}
