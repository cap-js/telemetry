// Mock console.dir to capture logs ConsoleMetricExporter writes
const consoleDirLogs = []
jest.spyOn(console, 'dir').mockImplementation((...args) => {
  consoleDirLogs.push(args)
})

const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

const { expect, GET, axios } = cds.test(
  __dirname + '/bookshop',
  '--with-mocks',
  '--profile',
  'metrics-outbox, multitenancy'
)
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
  let totalFailed = { [T1]: 0, [T2]: 0 }

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const externalServiceOne = await cds.connect.to('ExternalServiceOne')
    const externalServiceOneQ = cds.outboxed(externalServiceOne)

    proxyService.on('proxyCallToExternalServiceOne', async req => {
      totalInc[cds.context.tenant] += 1
      await externalServiceOneQ.send('call', {})
      return req.reply('OK')
    })

    // Register handler to avoid error due to unhandled action
    externalServiceOne.on('call', req => req.reply('OK'))
    externalServiceOne.before('*', () => {
      totalOut[cds.context.tenant] += 1
    })

    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(T1)
    await mts.subscribe(T2)
  })

  beforeEach(async () => {
    await cds.tx({ tenant: T1 }, () => DELETE.from('cds.outbox.Messages'))
    await cds.tx({ tenant: T2 }, () => DELETE.from('cds.outbox.Messages'))
    consoleDirLogs.length = 0
  })

  describe('given the target service succeeds immediately', () => {
    test('metrics are collected per tenant', async () => {
      if (cds.version.split('.')[0] < 9) return

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T2])
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
    let currentRetryCount, unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalServiceOne')

      unboxedService.before('call', req => {
        if ((currentRetryCount[cds.context.tenant] += 1) <= 2) {
          totalFailed[cds.context.tenant] += 1
          return req.reject({ status: 503 })
        }
      })
    })

    afterAll(() => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.before !== 'call')
    })

    beforeEach(() => {
      currentRetryCount = { [T1]: 0, [T2]: 0 }
    })

    test('storage time increases before message can be delivered', async () => {
      if (cds.version.split('.')[0] < 9) return

      const timeOfInitialCall = Date.now()
      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T2])
      ])

      // Wait for the first retry to be processed
      while (currentRetryCount[T1] < 2) await wait(10)
      while (currentRetryCount[T2] < 2) await wait(10)

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now()
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall))
      }
      await wait(300) // ... for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'processing_failures')).to.eq(totalFailed[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.be.gte(1)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'processing_failures')).to.eq(totalFailed[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(1)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.be.gte(1)

      // Wait for the second retry to be processd
      while (currentRetryCount[T1] < 3) await wait(10)
      while (currentRetryCount[T2] < 3) await wait(10)
      await wait(600) // ... for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(0)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'processing_failures')).to.eq(totalFailed[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(0)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'processing_failures')).to.eq(totalFailed[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
      expect(metricValue(T2, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T2, 'max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given a taget service that fails unrecoverably', () => {
    let unboxedService

    const didProcess = { [T1]: false, [T2]: false }

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalServiceOne')

      unboxedService.before('call', req => {
        didProcess[cds.context.tenant] = true
        totalFailed[cds.context.tenant] += 1
        return req.reject({ status: 418, unrecoverable: true })
      })
    })

    afterAll(async () => {
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.before !== 'call')
    })

    test('cold entry is observed', async () => {
      if (cds.version.split('.')[0] < 9) return

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T2])
      ])

      while (!didProcess[T1]) await wait(10)
      while (!didProcess[T2]) await wait(10)
      await wait(500) // ... for metrics to be collected

      expect(metricValue(T1, 'cold_entries')).to.eq(1)
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'processing_failures')).to.eq(totalFailed[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(1)
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
      expect(metricValue(T2, 'processing_failures')).to.eq(totalFailed[T2])
      expect(metricValue(T2, 'remaining_entries')).to.eq(0)
    })
  })
})
