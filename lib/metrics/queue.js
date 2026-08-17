const cds = require('@sap/cds')

const { metrics, ValueType } = require('@opentelemetry/api')

const LOG = cds.log('telemetry')

const PERSISTENT_QUEUE_DB_NAME = 'cds.outbox.Messages'

// Parse a queue `timestamp` value to epoch millis, robust to the DB driver's format.
// Direct column reads return an ISO-8601 UTC string ("...Z"), but HANA's min()/max()
// aggregates return a timezone-naive string ("2026-08-13 22:50:41.2270000" — space
// separator, sub-ms digits, no zone). Passing that straight to `new Date()` parses it as
// LOCAL time, so storage-time gauges were off by the machine's UTC offset on HANA (e.g. 7200s
// in CEST). Normalize naive strings to UTC before parsing; ISO/Date/number inputs pass through.
function timestampToEpoch(ts) {
  if (ts == null) return null
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts
  let s = String(ts).trim()
  // Already zoned (ends with Z or ±HH:MM / ±HHMM)? leave as-is; otherwise treat as UTC.
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    // "YYYY-MM-DD HH:MM:SS.fffffff" -> "YYYY-MM-DDTHH:MM:SS.fffZ" (trim sub-ms to 3 digits)
    s = s.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1') + 'Z'
  }
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

async function collectLatestQueueInfo(queueEntity, serviceName, maxAttempts) {
  const coldEntriesRow = await SELECT.one
    .columns([{ func: 'count', args: [{ val: 1 }], as: 'cold_count' }])
    .from(queueEntity).where`target = ${serviceName} or contains(msg, ${'"service":"' + serviceName})`.where({
    attempts: { '>=': maxAttempts }
  })

  const remaingEntriesInfoRow = await SELECT.one
    .columns([
      { func: 'count', args: [{ val: 1 }], as: 'remaining_count' },
      { func: 'min', args: [{ ref: ['timestamp'] }], as: 'min_timestamp' },
      { func: 'max', args: [{ ref: ['timestamp'] }], as: 'max_timestamp' }
    ])
    .from(queueEntity).where`target = ${serviceName} or contains(msg, ${'"service":"' + serviceName})`.where({
    attempts: { '<': maxAttempts }
  })

  const remainingEntries = remaingEntriesInfoRow?.['remaining_count'] ?? 0

  const medianStorageTimeRow = await SELECT.one.columns([{ ref: ['timestamp'], as: 'med_timestamp' }]).from(queueEntity)
    .where`target = ${serviceName} or contains(msg, ${'"service":"' + serviceName})`
    .where({ attempts: { '<': maxAttempts } })
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

  // Gauges

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

  // Counters

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

  observables.processingFailures = meter.createObservableCounter('queue.processing_failures', {
    description: 'Number of failed message processing attempts by the outbox.',
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

        // 'maxTimestamp' holds the most recent timestamp
        const maxEpoch = timestampToEpoch(stats.maxTimestamp)
        const minStorageTimeSeconds = maxEpoch ? Math.floor((now - maxEpoch) / 1000) : 0
        batchResult.observe(observables.minStorageTimeSeconds, minStorageTimeSeconds, observationAttributes)

        const medEpoch = timestampToEpoch(stats.medTimestamp)
        const medStorageTimeSeconds = medEpoch ? Math.floor((now - medEpoch) / 1000) : 0
        batchResult.observe(observables.medStorageTimeSeconds, medStorageTimeSeconds, observationAttributes)

        // 'minTimestamp' holds the least recent timestamp
        const minEpoch = timestampToEpoch(stats.minTimestamp)
        const maxStorageTimeSeconds = minEpoch ? Math.floor((now - minEpoch) / 1000) : 0
        batchResult.observe(observables.maxStorageTimeInSeconds, maxStorageTimeSeconds, observationAttributes)

        batchResult.observe(observables.incomingMessages, stats.incomingMessages, observationAttributes)

        batchResult.observe(observables.outgoingMessages, stats.outgoingMessages, observationAttributes)

        batchResult.observe(observables.processingFailures, stats.processingFailures, observationAttributes)
      }
    }
  }, Object.values(observables))
}

function tenantQueueStastics(statistics, tenant, queuedServiceName) {
  if (statistics[tenant]?.[queuedServiceName]) return statistics[tenant][queuedServiceName]

  if (!statistics[tenant]) statistics[tenant] = {}
  if (!statistics[tenant][queuedServiceName]) {
    statistics[tenant][queuedServiceName] = {
      incomingMessages: 0,
      outgoingMessages: 0,
      processingFailures: 0,
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
    const maxAttempts = cds.queued(cds.services[queuedServiceName]).outboxed.maxAttempts ?? 10
    const latestStatistics = await collectLatestQueueInfo(queueEntity, queuedServiceName, maxAttempts)
    Object.assign(statistics[tenant][queuedServiceName], latestStatistics)
  })

  return statistics[tenant][queuedServiceName]
}

module.exports = () => {
  // Skip setup if queue telemetry is disabled
  if (!cds.env.requires.telemetry.metrics?._queue) return

  /** @type {Record<[key: string], Record<[key: string], object>>} */
  const statistics = {}
  const registeredServices = new Set()

  cds.on('listening', () => {
    if (!cds.db) {
      LOG.debug('Skipping queue metrics setup as no database is connected')
      return
    }

    const queueEntity = cds.model.definitions[PERSISTENT_QUEUE_DB_NAME]
    if (!queueEntity) return

    initQueueObservation(statistics)

    // Register service when it's first found to be the target of an queued message
    // CDS >=10 (scheduling:true) uses UPSERT via Scheduler.scheduleTask; CDS 9 uses INSERT (fires as CREATE)
    cds.db.after(['CREATE', 'UPSERT'], queueEntity, async (_, createTaskReq) => {
      const tenant = cds.context?.tenant

      const queuedServiceName = JSON.parse(createTaskReq.data.msg || '{}').service ?? createTaskReq.data.target
      if (queuedServiceName === 'scheduling') return // skip internal scheduler flush markers

      const targetedService = cds.services[queuedServiceName]
      if (!targetedService) {
        LOG.debug('Skipping registration of queue metrics collection for unknown service:', queuedServiceName)
        return
      }

      // Increase the `incoming_messages` counter each time ...
      // > a new task is created in the persistent queue
      // In CDS >=10 (scheduling:true), retries also fire UPSERT with attempts > 0 — skip those
      if (createTaskReq.data.attempts == null) {
        tenantQueueStastics(statistics, tenant, queuedServiceName).incomingMessages += 1
      }

      if (!registeredServices.has(queuedServiceName)) {
        registeredServices.add(queuedServiceName)

        const unqueuedService = cds.unqueued(targetedService)

        // REVISIT: this assumes that the unqueued service is only used for processing queued messages.
        //          we should probably rather track when a message is set to "processing".
        //          that requires the new locking mechanism, though.
        const { handle } = unqueuedService
        unqueuedService.handle = async function () {
          const tenant = cds.context?.tenant

          const stats = tenantQueueStastics(statistics, tenant, queuedServiceName)

          // Increase the `outgoing_messages` counter each time ...
          // > the queued service is called to process a scheduled task
          stats.outgoingMessages += 1

          try {
            return await handle.apply(this, arguments)
          } catch (error) {
            // Increase the `processing_failures` counter each time ...
            // > the queued service failed to process a scheduled task
            stats.processingFailures += 1
            throw error
          }
        }
      }
    })
  })
}
