process.env.HOST_METRICS_LOG_SYSTEM = "true";
process.env.cds_requires_outbox = true;
process.env.cds_requires_telemetry_metrics = JSON.stringify({
  config: { exportIntervalMillis: 100 },
  _db_pool: false,
  _queue: false,
  exporter: {
    module: "@opentelemetry/sdk-metrics",
    class: "ConsoleMetricExporter",
  },
});

// Mock console.dir to capture logs ConsoleMetricExporter writes
const consoleDirLogs = [];
jest.spyOn(console, "dir").mockImplementation((...args) => {
  consoleDirLogs.push(args);
});

const cds = require("@sap/cds");
const { setTimeout: wait } = require("node:timers/promises");

const { expect, GET } = cds.test(__dirname + "/bookshop", "--with-mocks");

function metricValue(metric) {
  const mostRecentMetricLog = consoleDirLogs.findLast(
    (metricLog) => metricLog[0].descriptor.name === `queue.${metric}`
  )?.[0];

  if (!mostRecentMetricLog) return null;

  return mostRecentMetricLog.dataPoints[0].value;
}

describe("queue metrics is disabled", () => {
  const admin = { auth: { username: "alice" } };
  beforeAll(async () => {
    const proxyService = await cds.connect.to("ProxyService");
    const externalService = await cds.connect.to("ExternalService");
    const queuedService = cds.outboxed(externalService);

    proxyService.on("proxyCallToExternalService", async (req) => {
      await queuedService.send("call", {});
      return req.reply("OK");
    });

    externalService.before("*", () => {});
  });

  beforeEach(() => (consoleDirLogs.length = 0));

  test("metrics are not collected", async () => {
    if (cds.version.split(".")[0] < 9) return;

    await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

    await wait(150); // Wait for metrics to be collected

    expect(metricValue('cold_entries')).to.eq(null);
    expect(metricValue('remaining_entries')).to.eq(null);
    expect(metricValue('incoming_messages')).to.eq(null);
    expect(metricValue('outgoing_messages')).to.eq(null);
    expect(metricValue('min_storage_time_in_seconds')).to.eq(null);
    expect(metricValue('med_storage_time_in_seconds')).to.eq(null);
    expect(metricValue('max_storage_time_in_seconds')).to.eq(null);
  });
});
