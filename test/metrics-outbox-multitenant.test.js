process.env.cds_requires_outbox = true
process.env.cds_requires_telemetry_metrics = JSON.stringify({
  config: { exportIntervalMillis: 100 },
  _db_pool: false,
  _queue: true,
  exporter: {
    module: '@opentelemetry/sdk-metrics',
    class: 'ConsoleMetricExporter'
  }
})

// Mock console.dir to capture logs ConsoleMetricExporter writes
const consoleDirLogs = []
jest.spyOn(console, 'dir').mockImplementation((...args) => {
  consoleDirLogs.push(args)
})

const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

const { expect, GET, axios } = cds.test(__dirname + '/bookshop', '--profile', 'multitenancy', '--with-mocks')
axios.defaults.validateStatus = () => true

function metricValue(tenant, metric) {
  const mostRecentMetricLog = consoleDirLogs.findLast(
    metricLog => metricLog[0].descriptor.name === `queue.${metric}`
  )?.[0]

  if (!mostRecentMetricLog) return null

  const mostRecentTenantDataPoint = mostRecentMetricLog.dataPoints.find(
    dp => dp.attributes['sap.tenancy.tenant_id'] === tenant
  )
  return mostRecentTenantDataPoint ? mostRecentTenantDataPoint.value : null
}

describe('queue metrics for multi tenant service', () => {
  const T1 = 'tenant_1'
  const T2 = 'tenant_2'

  const user = {
    [T1]: { auth: { username: `user_${T1}` } },
    [T2]: { auth: { username: `user_${T2}` } }
  }

  let totalCold = { [T1]: 0, [T2]: 0 }
  let totalInc = { [T1]: 0, [T2]: 0 }
  let totalOut = { [T1]: 0, [T2]: 0 }
  
  // Baseline metrics to account for state from previous tests
  let baselineCold = { [T1]: 0, [T2]: 0 }
  let baselineInc = { [T1]: 0, [T2]: 0 }
  let baselineOut = { [T1]: 0, [T2]: 0 }

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const unboxedService = await cds.connect.to('ExternalService')
    const queuedService = cds.outboxed(unboxedService)

    proxyService.on('proxyCallToExternalService', async req => {
      totalInc[cds.context.tenant] += 1
      await queuedService.send('call', {})
      return req.reply('OK')
    })

    unboxedService.before('*', () => {
      totalOut[cds.context.tenant] += 1
    })

    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(T1)
    await mts.subscribe(T2)
  })

  beforeEach(async () => {
    consoleDirLogs.length = 0
    
    // Reset counters to prevent state leakage between tests
    totalCold = { [T1]: 0, [T2]: 0 }
    totalInc = { [T1]: 0, [T2]: 0 }
    totalOut = { [T1]: 0, [T2]: 0 }
    
    // Clear any existing queue entries to prevent metrics leakage between tests
    try {
      if (cds.db && cds.model.definitions['cds.outbox.Messages']) {
        await DELETE.from('cds.outbox.Messages')
      }
    } catch {
      // Ignore cleanup errors
    }
    
    // Force metrics collection to ensure clean state
    try {
      const telemetry = cds.services.telemetry
      if (telemetry && telemetry._metricReader) {
        await telemetry._metricReader.forceFlush()
      }
    } catch {
      // Ignore flush errors
    }
  })

  afterAll(async () => {
    // Clear any pending metrics timers and shutdown telemetry
    try {
      const telemetry = cds.services.telemetry
      if (telemetry && telemetry._metricReader) {
        await telemetry._metricReader.shutdown()
      }
    } catch {
      // Ignore telemetry shutdown errors
    }
    
    // Unsubscribe tenants to prevent hanging connections
    try {
      const mts = await cds.connect.to('cds.xt.DeploymentService')
      await mts.unsubscribe(T1)
      await mts.unsubscribe(T2)
    } catch {
      // Ignore unsubscribe errors
    }
    
    // Force cleanup of any remaining async operations
    try {
      await cds.shutdown()
    } catch {
      // Ignore shutdown errors
    }
  })

  describe('given the target service succeeds immediately', () => {
    let unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalService')

      unboxedService.on('call', req => {
        return req.reply('OK')
      })
    })

    afterAll(async () => {
      unboxedService.handlers.on = unboxedService.handlers.on.filter(handler => handler.event !== 'call')
    })
    test('metrics are collected per tenant', async () => {
      if (cds.version.split('.')[0] < 9) return

      // Get baseline metrics before test execution
      await wait(150) // Wait for any previous test metrics to be collected
      const baselineIncomingT1 = metricValue(T1, 'incoming_messages') || 0
      const baselineIncomingT2 = metricValue(T2, 'incoming_messages') || 0
      const baselineOutgoingT1 = metricValue(T1, 'outgoing_messages') || 0
      const baselineOutgoingT2 = metricValue(T2, 'outgoing_messages') || 0

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(150) // Wait for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(baselineIncomingT1 + totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(baselineOutgoingT1 + totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(baselineIncomingT2 + totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(baselineOutgoingT2 + totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given a target service that requires retries', () => {
    if (cds.version.split('.')[0] < 9) return

    let currentRetryCount = { [T1]: 0, [T2]: 0 }
    let unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalService')

      unboxedService.before('call', req => {
        if ((currentRetryCount[cds.context.tenant] += 1) <= 2) return req.reject({ status: 503 })
      })
    })

    beforeEach(() => {
      // Reset retry counter for each test
      currentRetryCount = { [T1]: 0, [T2]: 0 }
    })

    afterAll(() => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.event !== 'call')
    })

    test('storage time increases before message can be delivered', async () => {
      if (cds.version.split('.')[0] < 9) return

      // Get baseline metrics before test execution
      await wait(150) // Wait for any previous test metrics to be collected
      const baselineIncomingT1 = metricValue(T1, 'incoming_messages') || 0
      const baselineIncomingT2 = metricValue(T2, 'incoming_messages') || 0
      const baselineOutgoingT1 = metricValue(T1, 'outgoing_messages') || 0
      const baselineOutgoingT2 = metricValue(T2, 'outgoing_messages') || 0

      const timeOfInitialCall = Date.now()
      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(150) // ... for metrics to be collected
      expect(currentRetryCount[T1]).to.eq(1)
      expect(currentRetryCount[T2]).to.eq(1)

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(baselineIncomingT1 + totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(baselineOutgoingT1 + totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(baselineIncomingT2 + totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(baselineOutgoingT2 + totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(1)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)

      // Wait for the first retry to be initiated
      while (currentRetryCount[T1] < 2) await wait(100)
      while (currentRetryCount[T2] < 2) await wait(100)
      await wait(150) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[T1]).to.eq(2)
      expect(currentRetryCount[T2]).to.eq(2)

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now()
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall))
      }

      await wait(200) // ... for metrics to be collected again

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(baselineIncomingT1 + totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(baselineOutgoingT1 + totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.be.gte(1)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(baselineIncomingT2 + totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(baselineOutgoingT2 + totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(1)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.be.gte(1)

      // Wait for the second retry to be initiated
      while (currentRetryCount[T1] < 3) await wait(100)
      while (currentRetryCount[T2] < 3) await wait(100)
      await wait(150) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[T1]).to.eq(3)
      expect(currentRetryCount[T2]).to.eq(3)

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given a taget service that fails unrecoverably', () => {
    let unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalService')

      unboxedService.before('call', req => {
        totalCold[cds.context.tenant] += 1
        return req.reject({ status: 418, unrecoverable: true })
      })
    })

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.event !== 'call')
    })

    test('cold entry is observed', async () => {
      if (cds.version.split('.')[0] < 9) return

      // Get baseline metrics before test execution
      await wait(150) // Wait for any previous test metrics to be collected
      const baselineIncomingT1 = metricValue(T1, 'incoming_messages') || 0
      const baselineIncomingT2 = metricValue(T2, 'incoming_messages') || 0
      const baselineOutgoingT1 = metricValue(T1, 'outgoing_messages') || 0
      const baselineOutgoingT2 = metricValue(T2, 'outgoing_messages') || 0

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(150) // ... for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(baselineIncomingT1 + totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(baselineOutgoingT1 + totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(baselineIncomingT2 + totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(baselineOutgoingT2 + totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)
    })
  })
})
