const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const trace = require('./trace')
const wrap = require('./wrapper')

const _wrap_stmt = (stmt, impl, sql) => {
  for (const fn of ['run', 'get', 'all', 'stream', 'runBatch']) {
    if (!stmt[fn]) continue
    const it = stmt[fn]
    stmt[fn] = wrap(it, {
      no_locate: true,
      wrapper: function () {
        return trace(`${impl} - stmt.${fn} ${sql}`, it, this, arguments, { loggerName: LOG.label })
      }
    })
  }
  return stmt
}

module.exports = () => {
  if (!cds.env.requires.db) return

  const { impl } = cds.env.requires.db

  if (impl?.match(/^@cap-js\//)) {
    const dbService = require(impl)
    cds.once('served', () => {
      const { prepare, exec } = dbService.prototype
      dbService.prototype.prepare = wrap(prepare, {
        wrapper: function (sql) {
          const stmt = trace(`${impl} - prepare ${sql}`, prepare, this, arguments, { loggerName: LOG.label })
          if (stmt instanceof Promise) return stmt.then(stmt => _wrap_stmt(stmt, impl, sql))
          return _wrap_stmt(stmt, impl, sql)
        }
      })
      dbService.prototype.exec = wrap(exec, {
        wrapper: function (sql) {
          return trace(`${impl} - exec ${sql}`, exec, this, arguments, { loggerName: LOG.label })
        }
      })
    })
  }
}
