process.env.HOST_METRICS_LOG_SYSTEM = "true";
process.env.cds_requires_telemetry_metrics_config = JSON.stringify({
  exportIntervalMillis: 100,
});

const cds = require("@sap/cds");
const { beforeEach } = require("node:test");
const { setTimeout: wait } = require("node:timers/promises");

const { expect, GET, axios } = cds.test(
  __dirname + "/bookshop",
  "--profile",
  "multitenancy",
  "--with-mocks"
);
axios.defaults.validateStatus = () => true;
const log = cds.test.log();

function metricValue(tenant, metric) {
  const regx = new RegExp(
    `outbox\\.${metric}.*tenant "${tenant}"[\\s\\S]*?value:\\s*(\\d+)`,
    "gi"
  );
  const matches = [...log.output.matchAll(regx)];
  return matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : null;
}

describe("outbox metrics for multi tenant service", () => {
  const T1 = "tenant_1";
  const T2 = "tenant_2";

  const user = {
    [T1]: { auth: { username: `user_${T1}` } },
    [T2]: { auth: { username: `user_${T2}` } },
  };

  let totalCold = { [T1]: 0, [T2]: 0 };
  let totalInc = { [T1]: 0, [T2]: 0 };
  let totalOut = { [T1]: 0, [T2]: 0 };

  beforeAll(async () => {
    const proxyService = await cds.connect.to("ProxyService");
    const externalService = await cds.connect.to("ExternalService");
    const outboxedService = cds.outboxed(externalService);

    proxyService.on("proxyCallToExternalService", async (req) => {
      await outboxedService.send("call", {});
      totalInc[req.tenant] += 1;
      return req.reply("OK");
    });

    externalService.before("*", () => {
      totalOut[cds.context.tenant] += 1;
    });

    const mts = await cds.connect.to("cds.xt.DeploymentService");
    await mts.subscribe(T1);
    await mts.subscribe(T2);
  });

  beforeEach(log.clear);

  test("metrics are collected per tenant", async () => {
    await Promise.all([
      GET("/odata/v4/proxy/proxyCallToExternalService", user[T1]),
      GET("/odata/v4/proxy/proxyCallToExternalService", user[T2]),
    ]);

    await wait(150); // Wait for metrics to be collected

    expect(metricValue(T1, "cold_entries")).to.eq(totalCold[T1]);
    expect(metricValue(T1, "incoming_messages")).to.eq(totalInc[T1]);
    expect(metricValue(T1, "outgoing_messages")).to.eq(totalOut[T1]);
    expect(metricValue(T1, "remaining_entries")).to.eq(0);
    expect(metricValue(T1, "min_storage_time_in_seconds")).to.eq(0);
    expect(metricValue(T1, "med_storage_time_in_seconds")).to.eq(0);
    expect(metricValue(T1, "max_storage_time_in_seconds")).to.eq(0);

    expect(metricValue(T2, "cold_entries")).to.eq(totalCold[T2]);
    expect(metricValue(T2, "incoming_messages")).to.eq(totalInc[T2]);
    expect(metricValue(T2, "outgoing_messages")).to.eq(totalOut[T2]);
    expect(metricValue(T2, "remaining_entries")).to.eq(0);
    expect(metricValue(T2, "min_storage_time_in_seconds")).to.eq(0);
    expect(metricValue(T2, "med_storage_time_in_seconds")).to.eq(0);
    expect(metricValue(T2, "max_storage_time_in_seconds")).to.eq(0);
  });

  describe("given a target service that requires retries", () => {
    let currentRetryCount = { [T1]: 0, [T2]: 0 };
    let unboxedService;

    beforeAll(async () => {
      unboxedService = await cds.connect.to("ExternalService");

      unboxedService.before("call", (req) => {
        if ((currentRetryCount[cds.context.tenant] += 1) <= 2)
          return req.error({ status: 503 });
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
      await Promise.all([
        GET("/odata/v4/proxy/proxyCallToExternalService", user[T1]),
        GET("/odata/v4/proxy/proxyCallToExternalService", user[T2]),
      ]);

      await wait(150); // ... for metrics to be collected
      expect(currentRetryCount[T1]).to.eq(1);
      expect(currentRetryCount[T2]).to.eq(1);

      expect(metricValue(T1, "cold_entries")).to.eq(totalCold[T1]);
      expect(metricValue(T1, "incoming_messages")).to.eq(totalInc[T1]);
      expect(metricValue(T1, "outgoing_messages")).to.eq(totalOut[T1]);
      expect(metricValue(T1, "remaining_entries")).to.eq(1);
      expect(metricValue(T1, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "max_storage_time_in_seconds")).to.eq(0);

      expect(metricValue(T2, "cold_entries")).to.eq(totalCold[T2]);
      expect(metricValue(T2, "incoming_messages")).to.eq(totalInc[T2]);
      expect(metricValue(T2, "outgoing_messages")).to.eq(totalOut[T2]);
      expect(metricValue(T2, "remaining_entries")).to.eq(1);
      expect(metricValue(T2, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "max_storage_time_in_seconds")).to.eq(0);

      // Wait for the first retry to be initiated
      while (currentRetryCount[T1] < 2) await wait(100);
      while (currentRetryCount[T2] < 2) await wait(100);
      await wait(150); // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[T1]).to.eq(2);
      expect(currentRetryCount[T2]).to.eq(2);

      expect(metricValue(T1, "cold_entries")).to.eq(totalCold[T1]);
      expect(metricValue(T1, "incoming_messages")).to.eq(totalInc[T1]);
      expect(metricValue(T1, "outgoing_messages")).to.eq(totalOut[T1]);
      expect(metricValue(T1, "remaining_entries")).to.eq(1);
      expect(metricValue(T1, "min_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue(T1, "med_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue(T1, "max_storage_time_in_seconds")).to.be.gte(1);

      expect(metricValue(T2, "cold_entries")).to.eq(totalCold[T2]);
      expect(metricValue(T2, "incoming_messages")).to.eq(totalInc[T2]);
      expect(metricValue(T2, "outgoing_messages")).to.eq(totalOut[T2]);
      expect(metricValue(T2, "remaining_entries")).to.eq(1);
      expect(metricValue(T2, "min_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue(T2, "med_storage_time_in_seconds")).to.be.gte(1);
      expect(metricValue(T2, "max_storage_time_in_seconds")).to.be.gte(1);

      // Wait for the second retry to be initiated
      while (currentRetryCount[T1] < 3) await wait(100);
      while (currentRetryCount[T2] < 3) await wait(100);
      await wait(150); // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[T1]).to.eq(3);
      expect(currentRetryCount[T2]).to.eq(3);

      expect(metricValue(T1, "cold_entries")).to.eq(totalCold[T1]);
      expect(metricValue(T1, "incoming_messages")).to.eq(totalInc[T1]);
      expect(metricValue(T1, "outgoing_messages")).to.eq(totalOut[T1]);
      expect(metricValue(T1, "remaining_entries")).to.eq(0);
      expect(metricValue(T1, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "max_storage_time_in_seconds")).to.eq(0);

      expect(metricValue(T2, "cold_entries")).to.eq(totalCold[T2]);
      expect(metricValue(T2, "incoming_messages")).to.eq(totalInc[T2]);
      expect(metricValue(T2, "outgoing_messages")).to.eq(totalOut[T2]);
      expect(metricValue(T2, "remaining_entries")).to.eq(0);
      expect(metricValue(T2, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "max_storage_time_in_seconds")).to.eq(0);
    });
  });

  describe("given a taget service that fails unrecoverably", () => {
    let unboxedService;

    beforeAll(async () => {
      unboxedService = await cds.connect.to("ExternalService");

      unboxedService.before("call", (req) => {
        totalCold[cds.context.tenant] += 1;
        return req.error({ status: 418, unrecoverable: true });
      });
    });

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(
        (handler) => handler.before !== "call"
      );
    });

    test("cold entry is observed", async () => {
      await Promise.all([
        GET("/odata/v4/proxy/proxyCallToExternalService", user[T1]),
        GET("/odata/v4/proxy/proxyCallToExternalService", user[T2]),
      ]);

      await wait(150); // ... for metrics to be collected

      expect(metricValue(T1, "cold_entries")).to.eq(totalCold[T1]);
      expect(metricValue(T1, "incoming_messages")).to.eq(totalInc[T1]);
      expect(metricValue(T1, "outgoing_messages")).to.eq(totalOut[T1]);
      expect(metricValue(T1, "remaining_entries")).to.eq(0);
      expect(metricValue(T1, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T1, "max_storage_time_in_seconds")).to.eq(0);

      expect(metricValue(T2, "cold_entries")).to.eq(totalCold[T2]);
      expect(metricValue(T2, "incoming_messages")).to.eq(totalInc[T2]);
      expect(metricValue(T2, "outgoing_messages")).to.eq(totalOut[T2]);
      expect(metricValue(T2, "remaining_entries")).to.eq(0);
      expect(metricValue(T2, "min_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "med_storage_time_in_seconds")).to.eq(0);
      expect(metricValue(T2, "max_storage_time_in_seconds")).to.eq(0);
    });
  });
});
