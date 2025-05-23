process.env.HOST_METRICS_LOG_SYSTEM = "true";
process.env.cds_requires_outbox = true;
process.env.cds_requires_telemetry = JSON.stringify({
  metrics: {
    _outbox: false,
    metrics: { exportIntervalMillis: 100 },
  },
});

const cds = require("@sap/cds");
const { setTimeout: wait } = require("node:timers/promises");

const { expect, GET } = cds.test(__dirname + "/bookshop", "--with-mocks");
const log = cds.test.log();

function metricValue(metric) {
  const regx = new RegExp(`outbox\\.${metric}[\\s\\S]*?value:\\s*(\\d+)`, "gi");
  const matches = [...log.output.matchAll(regx)];
  return matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : null;
}

describe("outbox metrics is disabled", () => {
  const admin = { auth: { username: "alice" } };
  beforeAll(async () => {
    const proxyService = await cds.connect.to("ProxyService");
    const externalService = await cds.connect.to("ExternalService");
    const outboxedService = cds.outboxed(externalService);

    proxyService.on("proxyCallToExternalService", async (req) => {
      await outboxedService.send("call", {});
      return req.reply("OK");
    });

    externalService.before("*", () => {});
  });

  beforeEach(log.clear);

  test("metrics are not collected", async () => {
    await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

    await wait(150); // Wait for metrics to be collected

    expect(metricValue("cold_entries")).to.eq(null);
    expect(metricValue("remaining_entries")).to.eq(null);
    expect(metricValue("incoming_messages")).to.eq(null);
    expect(metricValue("outgoing_messages")).to.eq(null);
    expect(metricValue("min_storage_time_in_seconds")).to.eq(null);
    expect(metricValue("med_storage_time_in_seconds")).to.eq(null);
    expect(metricValue("max_storage_time_in_seconds")).to.eq(null);
  });
});
