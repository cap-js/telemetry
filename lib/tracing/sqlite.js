const api = require('@opentelemetry/api')
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')

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
        // REVISIT: When statement is in cds.spawn - error "Can not execute the operation on ended span" shows up
        if (span) span.setAttribute(SemanticAttributes.DB_STATEMENT, q)
      }
      return _super.call(this, q, ..._)
    }
  }

  return true
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

  return true
}

module.exports = () => {
  _instrument_sqlite() || _instrument_better_sqlite()
}
