const dbPool = require('./db-pool')

// REVISIT: why named function?
module.exports = function instrumentMetrics() {
  dbPool()
}
