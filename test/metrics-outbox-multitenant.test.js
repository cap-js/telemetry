process.env.cds_requires_outbox = true
process.env.cds_requires_telemetry_metrics = JSON.stringify({
  config: { exportIntervalMillis: 200 },
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

  let totalInc = { [T1]: 0, [T2]: 0 }
  let totalOut = { [T1]: 0, [T2]: 0 }

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const unboxedService = await cds.connect.to('ExternalService')
    const queuedService = cds.outboxed(unboxedService)

    proxyService.on('proxyCallToExternalService', async req => {
      totalInc[cds.context.tenant] += 1
      await queuedService.send('call', {})
      return req.reply('OK')
    })

    // Register handler to avoid error due to unhandled action
    unboxedService.on('call', req => req.reply('OK'))

    unboxedService.before('*', () => {
      totalOut[cds.context.tenant] += 1
    })

    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(T1)
    await mts.subscribe(T2)
  })

  beforeEach(async () => {
    await cds.tx({ tenant: T1 }, async (tx) => await tx.run(DELETE.from('cds.outbox.Messages')))
    await cds.tx({ tenant: T2 }, async (tx) => await tx.run(DELETE.from('cds.outbox.Messages')))
    consoleDirLogs.length = 0
  })

  describe('given the target service succeeds immediately', () => {
    test('metrics are collected per tenant', async () => {
      if (cds.version.split('.')[0] < 9) return

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(300) // Wait for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
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

    afterAll(() => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.before !== 'call')
    })

    test('storage time increases before message can be delivered', async () => {
      if (cds.version.split('.')[0] < 9) return

      const timeOfInitialCall = Date.now()
      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      while (currentRetryCount[T1] < 1) await wait(100)
      while (currentRetryCount[T2] < 1) await wait(100)
      await wait(300) // ... for metrics to be collected

      expect(currentRetryCount[T1]).to.eq(1)
      expect(currentRetryCount[T2]).to.eq(1)

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(1)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)

      // Wait for the first retry to be initiated
      while (currentRetryCount[T1] < 2) await wait(100)
      while (currentRetryCount[T2] < 2) await wait(100)
      await wait(300) // ... for the retry to be processed and metrics to be collected
      
      expect(currentRetryCount[T1]).to.eq(2)
      expect(currentRetryCount[T2]).to.eq(2)

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now()
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall))
      }

      await wait(300) // ... for metrics to be collected again

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.be.gte(1)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(1)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.be.gte(1)

      // Wait for the second retry to be initiated
      while (currentRetryCount[T1] < 3) await wait(100)
      while (currentRetryCount[T2] < 3) await wait(100)
      await wait(300) // ... for the retry to be processed and metrics to be collected

      expect(currentRetryCount[T1]).to.eq(3)
      expect(currentRetryCount[T2]).to.eq(3)

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
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

      unboxedService.before('call', req =>  req.reject({ status: 418, unrecoverable: true }))
    })

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.before !== 'call')
    })

    test('cold entry is observed', async () => {
      if (cds.version.split('.')[0] < 9) return

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(300) // ... for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(1)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(1)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)
    })
  })
})
