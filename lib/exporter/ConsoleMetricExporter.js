const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { ConsoleMetricExporter: StandardConsoleMetricExporter } = require('@opentelemetry/sdk-metrics')
const { ExportResultCode } = require('@opentelemetry/core')

const { inspect } = require('util')

class ConsoleMetricExporter extends StandardConsoleMetricExporter {
  export(metrics, resultCallback) {
    if (this._shutdown) {
      // If the exporter is shutting down, by spec, we need to return FAILED as export result
      setImmediate(resultCallback, { code: ExportResultCode.FAILED })
      return
    }

    for (const scopeMetrics of metrics.scopeMetrics) {
      if (scopeMetrics.scope.name.endsWith(':host-metrics')) {
        // aggregate host metrics
        const collector = {}
        for (const metric of scopeMetrics.metrics) {
          const { name } = metric.descriptor
          if (process.env.HOST_METRICS_LOG_SYSTEM) {
            if (name === 'system.cpu.time' || name === 'system.cpu.utilization') {
              collector[name] ??= {}
              for (const dp of metric.dataPoints) {
                collector[name][dp.attributes['system.cpu.state']] ??= []
                collector[name][dp.attributes['system.cpu.state']].push(dp.value)
              }
            }
            if (name === 'system.memory.usage' || name === 'system.memory.utilization') {
              collector[name] ??= {}
              for (const dp of metric.dataPoints) collector[name][dp.attributes.state] = dp.value
            }
            if (name === 'system.network.dropped' || name === 'system.network.errors' || name === 'system.network.io') {
              collector[name] ??= {}
              for (const dp of metric.dataPoints) {
                collector[name][dp.attributes.device] ??= {}
                collector[name][dp.attributes.device][dp.attributes.direction] = dp.value
              }
            }
          }
          if (name === 'process.cpu.time' || name === 'process.cpu.utilization') {
            collector[name] ??= {}
            for (const dp of metric.dataPoints) collector[name][dp.attributes.state] = dp.value
          }
          if (metric.descriptor.name === 'process.memory.usage') {
            collector[name] = metric.dataPoints[0].value
          }
        }
        // export host metrics
        let toLog = `host metrics:`
        for (const metric of scopeMetrics.metrics) {
          const value = collector[metric.descriptor.name]
          if (value) toLog += `\n  ${metric.descriptor.description}: ${inspect(value).split(/\n/).join('\n  ')}`
        }
        LOG.info(toLog)
      } else {
        // split between pool and other metrics
        const pool = {},
          other = {}
        for (const metric of scopeMetrics.metrics) {
          const match = metric.descriptor.name.match(/^db\.pool\.(\w+)$/)
          const name = match ? match[1] : metric.descriptor.name
          const collector = match ? pool : other
          for (const dp of metric.dataPoints) {
            const t = dp.attributes['sap.tenancy.tenant_id']
            collector[t] ??= {}
            collector[t][name] = match ? dp.value : dp
          }
        }
        // export pool metrics
        for (const tenant of Object.keys(pool)) {
          let toLog = `db.pool${tenant !== 'undefined' ? ` of tenant "${tenant}"` : ''}:`
          toLog += `\n     size | available | pending`
          toLog += `\n  ${`${pool[tenant].size}/${pool[tenant].max}`.padStart(
            7,
            ' '
          )} | ${`${pool[tenant].available}/${pool[tenant].size}`.padStart(
            9,
            ' '
          )} | ${`${pool[tenant].pending}`.padStart(7, ' ')}`
          LOG.info(toLog)
        }
        // export other metrics
        for (const tenant of Object.keys(other)) {
          for (const [k, v] of Object.entries(other[tenant])) {
            LOG.info(`${k}${tenant !== 'undefined' ? ` of tenant "${tenant}"` : ''}: ${inspect(v)}`)
          }
        }
      }
    }

    resultCallback({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = ConsoleMetricExporter
