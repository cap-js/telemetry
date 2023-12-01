const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { ConsoleMetricExporter: StandardConsoleMetricExporter } = require('@opentelemetry/sdk-metrics')
const { ExportResultCode, hrTimeToTimeStamp } = require('@opentelemetry/core')

class ConsoleMetricExporter extends StandardConsoleMetricExporter {
  export(metrics, resultCallback) {
    if (this._shutdown) {
      // If the exporter is shutting down, by spec, we need to return FAILED as export result
      setImmediate(resultCallback, { code: ExportResultCode.FAILED })
      return
    }

    // REVISIT: this needs to become more generic once we add more metrics!
    for (const scopeMetrics of metrics.scopeMetrics) {
      const tenant = scopeMetrics.metrics[0].dataPoints[0].attributes['sap.tenancy.tenant_id']
      const timestamp = hrTimeToTimeStamp(scopeMetrics.metrics[0].dataPoints[0].startTime)
      let toLog = `db.pool of tenant "${tenant}" at ${timestamp}:`
      const size = scopeMetrics.metrics.find(m => m.descriptor.name.match(/size/))
      const max = scopeMetrics.metrics.find(m => m.descriptor.name.match(/max/))
      const min = scopeMetrics.metrics.find(m => m.descriptor.name.match(/min/))
      const available = scopeMetrics.metrics.find(m => m.descriptor.name.match(/available/))
      // const borrowed = scopeMetric.metrics.find(m => m.descriptor.name.match(/borrowed/))
      // const spareResourceCapacity = scopeMetric.metrics.find(m => m.descriptor.name.match(/spareResourceCapacity/))
      const pending = scopeMetrics.metrics.find(m => m.descriptor.name.match(/pending/))
      toLog += `\n       |- size: ${size.dataPoints[0].value}/${max.dataPoints[0].value} (min: ${min.dataPoints[0].value})`
      toLog += `\n       |- available: ${available.dataPoints[0].value}/${size.dataPoints[0].value}`
      // REVISIT: isn't borrowed simply size - available?
      // toLog += `\n       |- borrowed: ${borrowed.dataPoints[0].value}/${size.dataPoints[0].value}`
      // REVISIT: isn't spareResourceCapacity simply max - size?
      // toLog += `\n       |- spareResourceCapacity: ${spareResourceCapacity.dataPoints[0].value}`
      toLog += `\n       |- pending: ${pending.dataPoints[0].value}`
      LOG.info(toLog)
    }
    resultCallback({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = ConsoleMetricExporter
