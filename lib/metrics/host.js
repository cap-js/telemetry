const { metrics } = require('@opentelemetry/api')

const { hasDependency } = require('../utils')

module.exports = () => {
  if (!hasDependency('@opentelemetry/host-metrics')) return

  const { HostMetrics } = require('@opentelemetry/host-metrics')
  const hostMetrics = new HostMetrics({
    meterProvider: metrics.getMeterProvider(), //> technically not needed but otherwise we get a warning
    name: '@cap-js/telemetry:host-metrics' //> REVISIT: what shall this name be?
  })
  hostMetrics.start()
}
