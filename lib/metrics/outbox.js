const cds = require("@sap/cds");

const { metrics, ValueType } = require("@opentelemetry/api");

const PERSISTENT_QUEUE_DB_NAME = "cds.outbox.Messages";

async function collectLatestOutboxInfo(queueEntity, serviceName, maxAttempts) {
  const coldEntriesRow = await SELECT.one
    .columns([{ func: "count", args: [{ val: 1 }], as: "cold_count" }])
    .from(queueEntity)
    .where({
      target: serviceName,
      attempts: { ">=": maxAttempts },
    });

  const remaingEntriesInfoRow = await SELECT.one
    .columns([
      { func: "count", args: [{ val: 1 }], as: "remaining_count" },
      { func: "min", args: [{ ref: ["timestamp"] }], as: "min_timestamp" },
      { func: "max", args: [{ ref: ["timestamp"] }], as: "max_timestamp" },
    ])
    .from(queueEntity)
    .where({
      target: serviceName,
      attempts: { "<": maxAttempts },
    });

  const remainingEntries = remaingEntriesInfoRow?.["remaining_count"] ?? 0;

  const medianStorageTimeRow = await SELECT.one
    .columns([{ ref: ["timestamp"], as: "med_timestamp" }])
    .from(queueEntity)
    .orderBy({ ref: ["timestamp"], sort: "asc" })
    .limit(1, Math.floor(remainingEntries / 2));

  return {
    coldEntries: coldEntriesRow?.["cold_count"] ?? 0,
    remainingEntries,
    minTimestamp: remaingEntriesInfoRow?.["min_timestamp"] ?? null,
    medTimestamp: medianStorageTimeRow?.["med_timestamp"] ?? null,
    maxTimestamp: remaingEntriesInfoRow?.["max_timestamp"] ?? null,
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
      description:
        "Number of incoming messages of the outbox. Increased by one each time a new message entry is created.",
      unit: "each",
      valueType: ValueType.INT,
    }
  );

  observables.outgoingMessages = meter.createObservableCounter(
    "outbox.outgoing_messages",
    {
      description:
        "Number of outgoing messages of the outbox. Increased by one each time a delivery attempt is made.",
      unit: "each",
      valueType: ValueType.INT,
    }
  );

  meter.addBatchObservableCallback((batchResult) => {
    for (const tenant in statistics) {
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
          ? Math.floor((now - new Date(stats.minTimestamp)) / 1000)
          : 0;
        batchResult.observe(
          observables.minStorageTimeSeconds,
          minStorageTimeSeconds,
          observationAttributes
        );

        const medStorageTimeSeconds = stats.medTimestamp
          ? Math.floor((now - new Date(stats.medTimestamp)) / 1000)
          : 0;
        batchResult.observe(
          observables.medStorageTimeSeconds,
          medStorageTimeSeconds,
          observationAttributes
        );

        const maxStorageTimeSeconds = stats.maxTimestamp
          ? Math.floor((now - new Date(stats.maxTimestamp)) / 1000)
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
        );

        batchResult.observe(
          observables.outgoingMessages,
          stats.outgoingMessages,
          observationAttributes
        );
      }
    }
  }, Object.values(observables));
}

function initTenantOutboxStatistics(statistics, tenant, outboxedServiceName) {
  if (!statistics[tenant]) statistics[tenant] = {};
  if (!statistics[tenant][outboxedServiceName]) {
    statistics[tenant][outboxedServiceName] = {
      incomingMessages: 0,
      outgoingMessages: 0,
      coldEntries: 0,
      remainingEntries: 0,
      minTimestamp: null,
      medTimestamp: null,
      maxTimestamp: null,
    };
  }
}

function registerOutboxStatisticsCollection(
  statistics,
  outboxedServiceName,
  queueEntity,
  tenantCollectionStatus
) {
  const unboxedService = cds.services[outboxedServiceName];
  const outboxedService = cds.outboxed(unboxedService);

  // REVISIT: Defaulting is required for cds^8 where the service does not expose 'maxAttempts'
  const maxAttempts = outboxedService?.outboxed?.maxAttempts ?? 20;

  unboxedService.before("*", async () => {
    const tenant = cds.context.tenant;

    statistics[tenant][outboxedServiceName].outgoingMessages += 1;

    cds.context.on("done", async () => {
      // Skip data collection if already in progress for the tenant
      if (!tenantCollectionStatus[tenant]) {
        tenantCollectionStatus[tenant] = true;

        // Create a privileged context for data collection
        const context = { user: cds.User.privileged };
        if (tenant) context.tenant = tenant;

        cds.spawn(context, async () => {
          const latestStatistics = await collectLatestOutboxInfo(
            queueEntity,
            outboxedServiceName,
            maxAttempts
          );

          Object.assign(
            statistics[tenant][outboxedServiceName],
            latestStatistics
          );

          tenantCollectionStatus[tenant] = false;
        });
      }
    });
  });
}

module.exports = () => {
  // Skip setup if outbox telemetry is disabled
  if (!cds.env.requires.telemetry.metrics?._outbox) return;

  /** @type {Record<[key: string], Record<[key: string], object>>} */
  const statistics = {};
  const registeredServices = new Set();
  /** @type {Record<[key: string], boolean>} */
  const tenantCollectionStatus = {};

  cds.on("listening", () => {
    const queueEntity = cds.model.definitions[PERSISTENT_QUEUE_DB_NAME];

    initOutboxObservation(statistics);

    // Register service when it's first found to be the target of an outboxed message
    cds.db.after(["CREATE"], queueEntity, async (_, req) => {
      const outboxedServiceName = req.data.target;

      if (!statistics[req.tenant]?.[outboxedServiceName]) {
        // Enable statistics collection per outbox per tenant
        initTenantOutboxStatistics(statistics, req.tenant, outboxedServiceName);

        // Ensure every outboxed service is only registered once
        if (!registeredServices.has(outboxedServiceName)) {
          registeredServices.add(outboxedServiceName);
          registerOutboxStatisticsCollection(
            statistics,
            outboxedServiceName,
            queueEntity,
            tenantCollectionStatus
          );
        }
      }

      statistics[req.tenant][outboxedServiceName].incomingMessages += 1;
    });
  });
};
