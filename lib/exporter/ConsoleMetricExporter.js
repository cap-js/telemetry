const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { ConsoleMetricExporter: StandardConsoleMetricExporter } = require('@opentelemetry/sdk-metrics')
const { ExportResultCode /* , hrTimeToTimeStamp */ } = require('@opentelemetry/core')

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

      // const timestamp = hrTimeToTimeStamp(scopeMetrics.metrics[0].dataPoints[0].startTime)
      // const timestamp = new Date().toISOString()
      // let toLog = `db.pool of tenant "${tenant}" at ${timestamp}:`

      let toLog = `db.pool of tenant "${tenant}":`

      const size = scopeMetrics.metrics.find(m => m.descriptor.name.match(/size/)).dataPoints[0].value
      const max = scopeMetrics.metrics.find(m => m.descriptor.name.match(/max/)).dataPoints[0].value
      // const min = scopeMetrics.metrics.find(m => m.descriptor.name.match(/min/)).dataPoints[0].value
      const available = scopeMetrics.metrics.find(m => m.descriptor.name.match(/available/)).dataPoints[0].value
      // const borrowed = scopeMetrics.metrics.find(m => m.descriptor.name.match(/borrowed/)).dataPoints[0].value
      // const spareResourceCapacity = scopeMetrics.metrics.find(m => m.descriptor.name.match(/spareResourceCapacity/)).dataPoints[0].value
      const pending = scopeMetrics.metrics.find(m => m.descriptor.name.match(/pending/)).dataPoints[0].value

      // toLog += `\n       |- size: ${size.dataPoints[0].value}/${max.dataPoints[0].value} (min: ${min.dataPoints[0].value})`
      // toLog += `\n       |- available: ${available.dataPoints[0].value}/${size.dataPoints[0].value}`
      // // REVISIT: isn't borrowed simply size - available?
      // // toLog += `\n       |- borrowed: ${borrowed.dataPoints[0].value}/${size.dataPoints[0].value}`
      // // REVISIT: isn't spareResourceCapacity simply max - size?
      // // toLog += `\n       |- spareResourceCapacity: ${spareResourceCapacity.dataPoints[0].value}`
      // toLog += `\n       |- pending: ${pending.dataPoints[0].value}`

      toLog += `\n     size | available | pending`
      toLog += `\n  ${`${size}/${max}`.padStart(7, ' ')} | ${`${available}/${size}`.padStart(
        9,
        ' '
      )} | ${`${pending}`.padStart(7, ' ')}`

      LOG.info(toLog)
    }

    resultCallback({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = ConsoleMetricExporter
