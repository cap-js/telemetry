process.env.cds_requires_outbox = true;
process.env.cds_requires_telemetry_metrics = JSON.stringify({
  config: { exportIntervalMillis: 100 },
  _db_pool: false,
  _queue: true,
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

describe("queue metrics for single tenant service", () => {
  let totalCold = 0;
  let totalInc = 0;
  let totalOut = 0;

  const admin = { auth: { username: "alice" } };

  beforeAll(async () => {
    const proxyService = await cds.connect.to("ProxyService");
    const externalService = await cds.connect.to("ExternalService");
    const queuedService = cds.queued(externalService);

    proxyService.on("proxyCallToExternalService", async (req) => {
      await queuedService.send("call", {});
      totalInc += 1;
      return req.reply("OK");
    });

    externalService.before("*", () => {
      totalOut += 1;
    });
  });

  beforeEach(() => (consoleDirLogs.length = 0));

  describe("given the target service succeeds immediately", () => {
    let unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to("ExternalService");

      unboxedService.on("call", (req) => {
        return req.reply("OK");
      })
    })

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(
        (handler) => handler.on !== "call"
      );
    });

    test("metrics are collected", async () => {
      if (cds.version.split(".")[0] < 9) return;
      
      await GET("/odata/v4/proxy/proxyCallToExternalService", admin);
      
      await wait(150); // Wait for metrics to be collected
      
      expect(metricValue("cold_entries")).to.eq(totalCold);
      expect(metricValue("remaining_entries")).to.eq(0);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("max_storage_time_in_seconds")).to.eq(0);
    });
  })

  describe("given a target service that requires retries", () => {
    let currentRetryCount = 0;
    let unboxedService;

    beforeAll(async () => {
      unboxedService = await cds.connect.to("ExternalService");

      unboxedService.before("call", (req) => {
        if ((currentRetryCount += 1) <= 2) return req.reject({ status: 503 });
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

    test("storage time increases before message can be delivered", async () => {
      if (cds.version.split(".")[0] < 9) return;

      const timeOfInitialCall = Date.now();
      await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

      await wait(150); // ... for metrics to be collected
      expect(currentRetryCount).to.eq(1);

      expect(metricValue("cold_entries")).to.eq(totalCold);
      expect(metricValue("remaining_entries")).to.eq(1);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("max_storage_time_in_seconds")).to.eq(0);

      // Wait for the first retry to be initiated
      while (currentRetryCount < 2) await wait(100);
      await wait(150); // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount).to.eq(2);

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now();
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall));
      }

      await wait(150); // ... for metrics to be collected again

      expect(metricValue("cold_entries")).to.eq(totalCold);
      expect(metricValue("remaining_entries")).to.eq(1);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue("med_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue("max_storage_time_in_seconds")).to.be.gte(1);

      // Wait for the second retry to be initiated
      while (currentRetryCount < 3) await wait(100);
      await wait(150); // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount).to.eq(3);

      expect(metricValue("cold_entries")).to.eq(totalCold);
      expect(metricValue("remaining_entries")).to.eq(0);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("max_storage_time_in_seconds")).to.eq(0);
    });
  });

  describe("given a target service that fails unrecoverably", () => {
    let unboxedService;

    beforeAll(async () => {
      unboxedService = await cds.connect.to("ExternalService");

      unboxedService.before("call", (req) => {
        totalCold += 1;
        return req.reject({ status: 418, unrecoverable: true });
      });
    });

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(
        (handler) => handler.before !== "call"
      );
    });

    test("cold entry is observed", async () => {
      if (cds.version.split(".")[0] < 9) return;

      await GET("/odata/v4/proxy/proxyCallToExternalService", admin);

      await wait(150); // ... for metrics to be collected

      expect(metricValue("cold_entries")).to.eq(totalCold);
      expect(metricValue("remaining_entries")).to.eq(0);
      expect(metricValue("incoming_messages")).to.eq(totalInc);
      expect(metricValue("outgoing_messages")).to.eq(totalOut);
      expect(metricValue("min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue("max_storage_time_in_seconds")).to.eq(0);
    });
  });
});
