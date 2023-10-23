// REVISIT: move to exporter folder (in project root, not in sub-folder)

const cds = require('@sap/cds')
const LOG = cds.log('otel', { label: 'otel:metrics' })

const { ExportResultCode, hrTimeToTimeStamp } = require('@opentelemetry/core')
const { ConsoleMetricExporter } = require('@opentelemetry/sdk-metrics')

class CDSConsoleMetricsExporter extends ConsoleMetricExporter {
  export(metrics, resultCallback) {
    if (this._shutdown) {
      // If the exporter is shutting down, by spec, we need to return FAILED as export result
      setImmediate(resultCallback, { code: ExportResultCode.FAILED })
      return
    }
    return CDSConsoleMetricsExporter._sendMetrics(metrics, resultCallback)
  }

  static _sendMetrics(metrics, done) {
    for (const scopeMetrics of metrics.scopeMetrics) {
      const tenant = scopeMetrics.metrics[0].dataPoints[0].attributes["sap.tenancy.tenant_id"]
      const timestamp = hrTimeToTimeStamp(scopeMetrics.metrics[0].dataPoints[0].startTime)
      let toLog = `db.pool of tenant "${tenant}" at ${timestamp}:`
      for (const metric of scopeMetrics.metrics) {
        toLog += `\n       |- ${metric.descriptor.name}: ${metric.dataPoints[0].value}`
      }
      LOG.info(toLog)
    }
    done({ code: ExportResultCode.SUCCESS })
  }
}

exports.CDSConsoleMetricsExporter = CDSConsoleMetricsExporter
