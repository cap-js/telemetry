// REVISIT: move to exporter folder (in project root, not in sub-folder)

const { ExportResultCode } = require('@opentelemetry/core')
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
      for (const metric of scopeMetrics.metrics) {
        //Only for local export, hence console
        console.dir(`OTEL Metric ${metric.descriptor.name} | Data Points:`, metric.dataPoints)
      }
    }
    done({ code: ExportResultCode.SUCCESS })
  }
}

exports.CDSConsoleMetricsExporter = CDSConsoleMetricsExporter
