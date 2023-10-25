const cds = require('@sap/cds')
const LOG = cds.log('otel', { label: 'otel:metrics' })

const { ExportResultCode, hrTimeToTimeStamp } = require('@opentelemetry/core')
const { ConsoleMetricExporter } = require('@opentelemetry/sdk-metrics')

class MyConsoleMetricExporter extends ConsoleMetricExporter {
  export(metrics, resultCallback) {
    if (this._shutdown) {
      // If the exporter is shutting down, by spec, we need to return FAILED as export result
      setImmediate(resultCallback, { code: ExportResultCode.FAILED })
      return
    }
    return MyConsoleMetricExporter._sendMetrics(metrics, resultCallback)
  }

  static _sendMetrics(metrics, done) {
    // REVISIT: this needs to become more generic once we add more metrics!
    for (const scopeMetric of metrics.scopeMetrics) {
      const tenant = scopeMetric.metrics[0].dataPoints[0].attributes['sap.tenancy.tenant_id']
      const timestamp = hrTimeToTimeStamp(scopeMetric.metrics[0].dataPoints[0].startTime)
      let toLog = `db.pool of tenant "${tenant}" at ${timestamp}:`
      const size = scopeMetric.metrics.find(m => m.descriptor.name.match(/size/))
      const max = scopeMetric.metrics.find(m => m.descriptor.name.match(/max/))
      const min = scopeMetric.metrics.find(m => m.descriptor.name.match(/min/))
      const available = scopeMetric.metrics.find(m => m.descriptor.name.match(/available/))
      // const borrowed = scopeMetric.metrics.find(m => m.descriptor.name.match(/borrowed/))
      // const spareResourceCapacity = scopeMetric.metrics.find(m => m.descriptor.name.match(/spareResourceCapacity/))
      const pending = scopeMetric.metrics.find(m => m.descriptor.name.match(/pending/))
      toLog += `\n       |- size: ${size.dataPoints[0].value}/${max.dataPoints[0].value} (min: ${min.dataPoints[0].value})`
      toLog += `\n       |- available: ${available.dataPoints[0].value}/${size.dataPoints[0].value}`
      // REVISIT: isn't borrowed simply size - available?
      // toLog += `\n       |- borrowed: ${borrowed.dataPoints[0].value}/${size.dataPoints[0].value}`
      // REVISIT: isn't spareResourceCapacity simply max - size?
      // toLog += `\n       |- spareResourceCapacity: ${spareResourceCapacity.dataPoints[0].value}`
      toLog += `\n       |- pending: ${pending.dataPoints[0].value}`
      LOG.info(toLog)
    }
    done({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = MyConsoleMetricExporter
