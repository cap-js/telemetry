const cds = require("@sap/cds");
const LOG = cds.log("telemetry");
const { SELECT } = cds.ql;

const { metrics, ValueType } = require("@opentelemetry/api");

const PERSISTENT_QUEUE_DB_NAME = "cds.outbox.Messages";

async function collectLatestOutboxInfo(
  tx,
  queueEntity,
  serviceName,
  maxAttempts
) {
  const coldEntriesRow = await tx.run(
    SELECT.one
      .columns([{ func: "count", args: [{ val: 1 }], as: "cold_count" }])
      .from(queueEntity)
      .where({
        target: serviceName,
        attempts: { ">=": maxAttempts },
      })
  );

  const coldEntries = coldEntriesRow?.["cold_count"] ?? 0;

  const remaingEntriesInfoRow = await tx.run(
    SELECT.one
      .columns([
        { func: "count", args: [{ val: 1 }], as: "remaining_count" },
        { func: "min", args: [{ ref: ["timestamp"] }], as: "min_timestamp" },
        { func: "max", args: [{ ref: ["timestamp"] }], as: "max_timestamp" },
      ])
      .from(queueEntity)
      .where({
        target: serviceName,
        attempts: { "<": maxAttempts },
      })
  );

  const remainingEntries = remaingEntriesInfoRow?.["remaining_count"] ?? 0;
  const minTimestamp = remaingEntriesInfoRow?.["min_timestamp"] ?? null;
  const maxTimestamp = remaingEntriesInfoRow?.["max_timestamp"] ?? null;

  const medianStorageTimeRow = await tx.run(
    SELECT.one
      .columns([{ ref: ["timestamp"], as: "med_timestamp" }])
      .from(queueEntity)
      .orderBy({ ref: ["timestamp"], sort: "asc" })
      .limit(1, Math.floor(remainingEntries / 2))
  );

  const medTimestamp = medianStorageTimeRow?.["med_timestamp"] ?? null;

  return {
    coldEntries,
    remainingEntries,
    minTimestamp,
    maxTimestamp,
    medTimestamp,
  };
}

function initOutboxObservation(statistics) {
  const meter = metrics.getMeter("@cap-js/telemetry:outbox");
  const observables = {};

  observables.coldEntries = meter.createObservableGauge("outbox.cold_entries", {
    description:
      "Number of entries that could not be delivered after repeated attempts and will not be retried anymore.",
    unit: "each",
    valueType: ValueType.INT,
  });

  observables.remainingEntries = meter.createObservableGauge(
    "outbox.remaining_entries",
    {
      description: "Number of entries which are pending for delivery.",
      unit: "each",
      valueType: ValueType.INT,
    }
  );

  observables.minStorageTimeSeconds = meter.createObservableGauge(
    "outbox.min_storage_time_in_seconds",
    {
      description: "Minimal time in seconds an entry was stored in the outbox.",
      unit: "seconds",
      valueType: ValueType.INT,
    }
  );

  observables.medStorageTimeSeconds = meter.createObservableGauge(
    "outbox.med_storage_time_in_seconds",
    {
      description: "Median time in seconds of an entry stored in the outbox.",
      unit: "seconds",
      valueType: ValueType.INT,
    }
  );

  observables.maxStorageTimeInSeconds = meter.createObservableGauge(
    "outbox.max_storage_time_in_seconds",
    {
      description:
        "Maximum time in seconds an entry was residing in the outbox.",
      unit: "seconds",
      valueType: ValueType.INT,
    }
  );

  observables.incomingMessages = meter.createObservableCounter(
    "outbox.incoming_messages",
    {
      description: "Number of incoming messages of the outbox.",
      unit: "each",
      valueType: ValueType.INT,
    }
  );

  observables.outgoingMessages = meter.createObservableCounter(
    "outbox.outgoing_messages",
    {
      description: "Number of outgoing messages of the outbox.",
      unit: "each",
      valueType: ValueType.INT,
    }
  );

  meter.addBatchObservableCallback((batchResult) => {
    for (const tenant in statistics) {
      // Create an approprate context
      const context = { user: cds.User.privileged };
      if (tenant) context.tenant = tenant;

      for (const [name, stats] of Object.entries(statistics[tenant])) {
        const now = Date.now();
        const observationAttributes = {
          "sap.tenancy.tenant_id": tenant,
          "outbox.name": name,
        };

        batchResult.observe(
          observables.coldEntries,
          stats.coldEntries,
          observationAttributes
        );

        batchResult.observe(
          observables.remainingEntries,
          stats.remainingEntries,
          observationAttributes
        );

        const minStorageTimeSeconds = stats.minTimestamp
          ? (now - new Date(stats.minTimestamp)) / 1000
          : 0;
        batchResult.observe(
          observables.minStorageTimeSeconds,
          minStorageTimeSeconds,
          observationAttributes
        );

        const medStorageTimeSeconds = stats.medTimestamp
          ? (now - new Date(stats.medTimestamp)) / 1000
          : 0;
        batchResult.observe(
          observables.medStorageTimeSeconds,
          medStorageTimeSeconds,
          observationAttributes
        );

        const maxStorageTimeSeconds = stats.maxTimestamp
          ? (now - new Date(stats.maxTimestamp)) / 1000
          : 0;
        batchResult.observe(
          observables.maxStorageTimeInSeconds,
          maxStorageTimeSeconds,
          observationAttributes
        );

        batchResult.observe(
            observables.incomingMessages,
            stats.incomingMessages,
            observationAttributes
        )

        batchResult.observe(
            observables.outgoingMessages,
            stats.outgoingMessages,
            observationAttributes
        )
      }
    }
  }, Object.values(observables));
}

module.exports = () => {
  // Skip setup if outbox telemetry is disabled
  if (!cds.env.requires.telemetry.metrics?._outbox) return;

  /** @type {Record<[key: string], Record<[key: string], object>>} */
  const statistics = {};
  const registeredServices = new Set();

  cds.on("listening", () => {
    const queueEntity = cds.model.definitions[PERSISTENT_QUEUE_DB_NAME];

    initOutboxObservation(statistics);

    cds.db.after(["CREATE"], queueEntity, async (_, req) => {
      // Ensure every outboxed service is only registered once
      const outboxedServiceName = req.data.target;
      if (registeredServices.has(outboxedServiceName)) return;
      registeredServices.add(outboxedServiceName);

      const unboxedService = cds.services[outboxedServiceName];
      const outboxedService = cds.outboxed(unboxedService);

      if (!statistics[req.tenant]) statistics[req.tenant] = {};
      if (!statistics[req.tenant][outboxedServiceName]) {
        statistics[req.tenant][outboxedServiceName] = {
          incomingMessages: 0,
          outgoingMessages: 0,
          coldEntries: 0,
          remainingEntries: 0,
          minTimestamp: null,
          medTimestamp: null,
          maxTimestamp: null,
        };
      }

      // TODO: Fix this!
      // TODO: May use different identifier for relevant configs
      // TODO: May use local config, set during cds.outboxed
      const maxAttempts = unboxedService?.options?.outbox?.maxAttempts ?? 20;

      outboxedService.after("*", (_, qReq) => {
        statistics[qReq.tenant][outboxedServiceName].incomingMessages += 1;
      });

      unboxedService.after("*", (_, qReq) => {
        statistics[qReq.tenant][outboxedServiceName].outgoingMessages += 1;
      });

      unboxedService.before("*", async (qReq) => {
        const tenant = qReq.tenant;

        // TODO: For some reason, qReq.on('done') is not triggered
        cds.context.on("done", async () => {
          const context = { user: cds.User.privileged };
          if (tenant) context.tenant = tenant;
          const tx = cds.tx(context);

          const latestStatistics = await collectLatestOutboxInfo(
            tx,
            queueEntity,
            outboxedServiceName,
            maxAttempts
          );

          Object.assign(
            statistics[tenant][outboxedServiceName],
            latestStatistics
          );
        });
      });
    });
  });
};
