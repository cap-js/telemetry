const cds = require('@sap/cds')

const { metrics, ValueType } = require('@opentelemetry/api')

const PERSISTENT_QUEUE_DB_NAME = 'cds.outbox.Messages'

async function collectLatestQueueInfo(queueEntity, serviceName, maxAttempts) {
  const coldEntriesRow = await SELECT.one
    .columns([{ func: 'count', args: [{ val: 1 }], as: 'cold_count' }])
    .from(queueEntity)
    .where({
      target: serviceName,
      attempts: { '>=': maxAttempts }
    })

  const remaingEntriesInfoRow = await SELECT.one
    .columns([
      { func: 'count', args: [{ val: 1 }], as: 'remaining_count' },
      { func: 'min', args: [{ ref: ['timestamp'] }], as: 'min_timestamp' },
      { func: 'max', args: [{ ref: ['timestamp'] }], as: 'max_timestamp' }
    ])
    .from(queueEntity)
    .where({
      target: serviceName,
      attempts: { '<': maxAttempts }
    })

  const remainingEntries = remaingEntriesInfoRow?.['remaining_count'] ?? 0

  const medianStorageTimeRow = await SELECT.one
    .columns([{ ref: ['timestamp'], as: 'med_timestamp' }])
    .from(queueEntity)
    .orderBy({ ref: ['timestamp'], sort: 'asc' })
    .limit(1, Math.floor(remainingEntries / 2))

  return {
    coldEntries: coldEntriesRow?.['cold_count'] ?? 0,
    remainingEntries,
    minTimestamp: remaingEntriesInfoRow?.['min_timestamp'] ?? null,
    medTimestamp: medianStorageTimeRow?.['med_timestamp'] ?? null,
    maxTimestamp: remaingEntriesInfoRow?.['max_timestamp'] ?? null
  }
}

function initQueueObservation(statistics) {
  const meter = metrics.getMeter('@cap-js/telemetry:queue')
  const observables = {}

  observables.coldEntries = meter.createObservableGauge('queue.cold_entries', {
    description:
      'Number of entries that could not be delivered after repeated attempts and will not be retried anymore.',
    unit: 'each',
    valueType: ValueType.INT
  })

  observables.remainingEntries = meter.createObservableGauge('queue.remaining_entries', {
    description: 'Number of entries which are pending for delivery.',
    unit: 'each',
    valueType: ValueType.INT
  })

  observables.minStorageTimeSeconds = meter.createObservableGauge('queue.min_storage_time_in_seconds', {
    description: 'Minimal time in seconds an entry was stored in the queue.',
    unit: 'seconds',
    valueType: ValueType.INT
  })

  observables.medStorageTimeSeconds = meter.createObservableGauge('queue.med_storage_time_in_seconds', {
    description: 'Median time in seconds of an entry stored in the queue.',
    unit: 'seconds',
    valueType: ValueType.INT
  })

  observables.maxStorageTimeInSeconds = meter.createObservableGauge('queue.max_storage_time_in_seconds', {
    description: 'Maximum time in seconds an entry was residing in the queue.',
    unit: 'seconds',
    valueType: ValueType.INT
  })

  observables.incomingMessages = meter.createObservableCounter('queue.incoming_messages', {
    description: 'Number of incoming messages of the queue. Increased by one each time a new message entry is created.',
    unit: 'each',
    valueType: ValueType.INT
  })

  observables.outgoingMessages = meter.createObservableCounter('queue.outgoing_messages', {
    description: 'Number of outgoing messages of the queue. Increased by one each time a delivery attempt is made.',
    unit: 'each',
    valueType: ValueType.INT
  })

  meter.addBatchObservableCallback(batchResult => {
    for (const tenant in statistics) {
      for (const [serviceName, stats] of Object.entries(statistics[tenant])) {
        const now = Date.now()
        const observationAttributes = {
          'sap.tenancy.tenant_id': tenant,
          'queue.name': serviceName
        }

        batchResult.observe(observables.coldEntries, stats.coldEntries, observationAttributes)

        batchResult.observe(observables.remainingEntries, stats.remainingEntries, observationAttributes)

        const minStorageTimeSeconds = stats.minTimestamp ? Math.floor((now - new Date(stats.minTimestamp)) / 1000) : 0
        batchResult.observe(observables.minStorageTimeSeconds, minStorageTimeSeconds, observationAttributes)

        const medStorageTimeSeconds = stats.medTimestamp ? Math.floor((now - new Date(stats.medTimestamp)) / 1000) : 0
        batchResult.observe(observables.medStorageTimeSeconds, medStorageTimeSeconds, observationAttributes)

        const maxStorageTimeSeconds = stats.maxTimestamp ? Math.floor((now - new Date(stats.maxTimestamp)) / 1000) : 0
        batchResult.observe(observables.maxStorageTimeInSeconds, maxStorageTimeSeconds, observationAttributes)

        batchResult.observe(observables.incomingMessages, stats.incomingMessages, observationAttributes)

        batchResult.observe(observables.outgoingMessages, stats.outgoingMessages, observationAttributes)
      }
    }
  }, Object.values(observables))
}

function initTenantQueueStatistics(statistics, tenant, queuedServiceName) {
  if (statistics[tenant]?.[queuedServiceName]) return

  if (!statistics[tenant]) statistics[tenant] = {}
  if (!statistics[tenant][queuedServiceName]) {
    statistics[tenant][queuedServiceName] = {
      incomingMessages: 0,
      outgoingMessages: 0,
      coldEntries: 0,
      remainingEntries: 0,
      minTimestamp: null,
      medTimestamp: null,
      maxTimestamp: null
    }
  }

  // Create a privileged context for data collection
  const privileged_context = { user: cds.User.privileged }
  if (tenant) privileged_context.tenant = tenant
  privileged_context.every = cds.env.requires.telemetry.metrics.config.exportIntervalMillis / 2

  cds.spawn(privileged_context, async () => {
    const queueEntity = cds.model.definitions[PERSISTENT_QUEUE_DB_NAME]
    // REVISIT: stable access to queue config
    const maxAttempts = cds.queued(cds.services[queuedServiceName]).outboxed.maxAttempts ?? 20
    const latestStatistics = await collectLatestQueueInfo(queueEntity, queuedServiceName, maxAttempts)
    Object.assign(statistics[tenant][queuedServiceName], latestStatistics)
  })
}

module.exports = () => {
  // Skip setup if queue telemetry is disabled
  if (!cds.env.requires.telemetry.metrics?._queue) return

  // Skip setup if the cds version is lower than 9
  if (cds.version.split('.')[0] < 9) return

  /** @type {Record<[key: string], Record<[key: string], object>>} */
  const statistics = {}
  const registeredServics = new Set()

  cds.on('listening', () => {
    if (!cds.db) {
      cds.log('telemetry').debug('Skipping queue metrics setup as no database is connected')
      return
    }

    const queueEntity = cds.model.definitions[PERSISTENT_QUEUE_DB_NAME]
    if (!queueEntity) return

    initQueueObservation(statistics)

    // Register service when it's first found to be the target of an queued message
    cds.db.after(['CREATE'], queueEntity, async (_, req) => {
      const tenant = cds.context?.tenant

      const queuedServiceName = req.data.target

      if (!registeredServics.has(queuedServiceName)) {
        cds.unqueued(cds.services[queuedServiceName]).before('*', () => {
          const tenant = cds.context?.tenant

          // Initialize statistics for the tenant and service if not already done
          initTenantQueueStatistics(statistics, tenant, queuedServiceName)

          statistics[tenant][queuedServiceName].outgoingMessages += 1
        })
        registeredServics.add(queuedServiceName)
      }

      // Initialize statistics for the tenant and service if not already done
      initTenantQueueStatistics(statistics, tenant, queuedServiceName)

      statistics[tenant][queuedServiceName].incomingMessages += 1
    })
  })
}
