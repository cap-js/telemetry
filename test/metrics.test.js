// process.env.HOST_METRICS_RETAIN_SYSTEM = 'true' //> with this the test would fail
process.env.HOST_METRICS_LOG_SYSTEM = "true";
process.env.cds_requires_telemetry_metrics_config = JSON.stringify({
  exportIntervalMillis: 100,
});

const cds = require("@sap/cds");
const { beforeEach } = require("node:test");
const { expect, GET } = cds.test(__dirname + "/bookshop", "--with-mocks");
const log = cds.test.log();

const wait = require("node:timers/promises").setTimeout;

describe("metrics", () => {
  const admin = { auth: { username: "alice" } };

  beforeEach(log.clear);

  test("system metrics are not collected by default", async () => {
    const { status } = await GET("/odata/v4/admin/Books", admin);
    expect(status).to.equal(200);

    await wait(100);

    expect(log.output).to.match(/process/i);
    expect(log.output).not.to.match(/network/i);
  });

  describe("outbox", () => {
    let totalInc = 0;
    let totalOut = 0;

    beforeAll(async () => {
      const proxyService = await cds.connect.to("ProxyService");
      const externalService = await cds.connect.to("ExternalService");
      const outboxedService = cds.outboxed(externalService);

      proxyService.on("proxyCallToExternalService", async (req) => {
        await outboxedService.send("call", {});
        totalInc += 1;
        return req.reply("OK");
      });

      externalService.before("*", () => {
        totalOut += 1;
      });
    });

    const metricValue = (metric) => {
      const regx = new RegExp(
        `outbox\\.${metric}[\\s\\S]*?value:\\s*(\\d+)`,
        "gi"
      );
      const matches = [...log.output.matchAll(regx)];
      return matches.length > 0
        ? parseInt(matches[matches.length - 1][1])
        : null;
    };

    test("metrics are collected", async () => {
      await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

      await wait(150); // Wait for metrics to be collected

      expect(metricValue("cold_entries")).to.eq(0);
      expect(metricValue("remaining_entries")).to.eq(0);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("max_storage_time_in_seconds")).to.eq(0);
    });

    describe("target service requires retries", () => {
      let currentRetryCount = 0;
      let unboxedService;

      beforeAll(async () => {
        unboxedService = await cds.connect.to("ExternalService");

        unboxedService.before("call", (req) => {
          if ((currentRetryCount += 1) <= 2) return req.error({ status: 503 });
        });
      });

      afterAll(async () => {
        unboxedService.handlers.before = unboxedService.handlers.before.filter(
          (handler) => handler.before !== "call"
        );
      });

      beforeEach(() => {
        currentRetryCount = 0;
      });

      test("metrics on retried messages", async () => {
        await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

        await wait(100); // Wait for metrics to be collected
        expect(currentRetryCount).to.eq(1);

        expect(metricValue("cold_entries")).to.eq(0);
        expect(metricValue("remaining_entries")).to.eq(1);
        expect(metricValue("incoming_messages")).to.eq(totalInc);
        expect(metricValue("outgoing_messages")).to.eq(totalOut);
        expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
        expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
        expect(metricValue("max_storage_time_in_seconds")).to.eq(0);

        // Wait for the first retry to be initiated
        while (currentRetryCount < 2) await wait(250);
        await wait(200); // Wait for retry to be processed and metrics to be collected
        expect(currentRetryCount).to.eq(2);

        expect(metricValue("cold_entries")).to.eq(0);
        expect(metricValue("remaining_entries")).to.eq(1);
        expect(metricValue("incoming_messages")).to.eq(totalInc);
        expect(metricValue("outgoing_messages")).to.eq(totalOut);
        expect(metricValue("min_storage_time_in_seconds")).to.be.gte(1);
        expect(metricValue("med_storage_time_in_seconds")).to.be.gte(1);
        expect(metricValue("max_storage_time_in_seconds")).to.be.gte(1);

        // Wait for the second retry to be initiated
        while (currentRetryCount < 3) await wait(250);
        await wait(200); // Wait for retry to be processed and metrics to be collected
        expect(currentRetryCount).to.eq(3);

        expect(metricValue("cold_entries")).to.eq(0);
        expect(metricValue("remaining_entries")).to.eq(0);
        expect(metricValue("incoming_messages")).to.eq(totalInc);
        expect(metricValue("outgoing_messages")).to.eq(totalOut);
        expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
        expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
        expect(metricValue("max_storage_time_in_seconds")).to.eq(0);
      });
    });
  });
});
