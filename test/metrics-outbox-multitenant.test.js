process.env.HOST_METRICS_LOG_SYSTEM = 'true'
process.env.cds_requires_telemetry_metrics_exporter = JSON.stringify({
  module: "../test/metrics-exporter",
  class: "TestMetricsExporter",
});
process.env.cds_requires_telemetry_metrics_config = JSON.stringify({
  exportIntervalMillis: 100
})
process.env.cds_requires_outbox = true

const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

const { expect, GET, axios } = cds.test(__dirname + '/bookshop', '--profile', 'multitenancy', '--with-mocks')
axios.defaults.validateStatus = () => true
const log = cds.test.log()

function metricValue(tenant, metric) {
  const regx = new RegExp(`queue\\.${metric}.*tenant "${tenant}"[\\s\\S]*?value:\\s*(\\d+)`, 'gi')
  const matches = [...log.output.matchAll(regx)]
  return matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : null
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

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const unboxedService = await cds.connect.to('ExternalService')
    const queuedService = cds.outboxed(unboxedService)

    proxyService.on('proxyCallToExternalService', async req => {
      totalInc[req.tenant] += 1
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

  beforeEach(() => {
    log.clear()
  })

  test('metrics are collected per tenant', async () => {
    if (cds.version.split('.')[0] < 9) return

    await Promise.all([
      GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
      GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
    ])

    await wait(150) // Wait for metrics to be collected

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

      await wait(150) // ... for metrics to be collected
      expect(currentRetryCount[T1]).to.eq(1)
      expect(currentRetryCount[T2]).to.eq(1)

      expect(metricValue(T1, 'cold_entries')).to.eq(totalCold[T1])
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.eq(0)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
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
      expect(metricValue(T1, 'incoming_messages')).to.eq(totalInc[T1])
      expect(metricValue(T1, 'outgoing_messages')).to.eq(totalOut[T1])
      expect(metricValue(T1, 'remaining_entries')).to.eq(1)
      expect(metricValue(T1, 'min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue(T1, 'max_storage_time_in_seconds')).to.be.gte(1)

      expect(metricValue(T2, 'cold_entries')).to.eq(totalCold[T2])
      expect(metricValue(T2, 'incoming_messages')).to.eq(totalInc[T2])
      expect(metricValue(T2, 'outgoing_messages')).to.eq(totalOut[T2])
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
      unboxedService.handlers.before = unboxedService.handlers.before.filter(handler => handler.before !== 'call')
    })

    test('cold entry is observed', async () => {
      if (cds.version.split('.')[0] < 9) return

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalService', user[T2])
      ])

      await wait(150) // ... for metrics to be collected

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
})
