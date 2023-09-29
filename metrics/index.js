const pooling = require('./pooling-metric')

module.exports = function instrumentMetrics() {
  pooling()
}