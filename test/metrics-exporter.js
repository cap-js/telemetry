const cds = require("@sap/cds");
const LOG = cds.log("telemetry");

const { inspect } = require("util");

const { ConsoleMetricExporter } = require("@opentelemetry/sdk-metrics");
const { ExportResultCode } = require("@opentelemetry/core");

class TestMetricsExporter extends ConsoleMetricExporter {
  export(metrics, resultCallback) {
    for (const scopeMetrics of metrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        for (const dp of metric.dataPoints) {
          const tenant = dp.attributes["sap.tenancy.tenant_id"] || "undefined";
          LOG.info(
            `${metric.descriptor.name}${
              tenant !== "undefined" ? ` of tenant "${tenant}"` : ""
            }: ${inspect(dp)}`
          );
        }
      }
    }

    resultCallback({ code: ExportResultCode.SUCCESS });
  }
}

module.exports = { TestMetricsExporter };
