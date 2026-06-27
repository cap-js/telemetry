// Capture exported metric data via ConsoleMetricExporter's console.dir output
const consoleDirLogs = []
jest.spyOn(console, 'dir').mockImplementation((...args) => {
  consoleDirLogs.push(args)
})

const cds = require('@sap/cds')
const { metrics } = require('@opentelemetry/api')
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

// State-based wait: force the metric provider to export, then re-run the assertion block.
// Replaces all fixed-time `wait(150)`-style sleeps — the loop completes the instant the in-memory
// queue statistics (kept fresh by the existing cds.spawn poller) reflect the asserted state.
async function expectEventually(assertion, { timeout = 10000, interval = 25 } = {}) {
  const start = Date.now()
  let lastError
  while (true) {
    await metrics.getMeterProvider().forceFlush?.()
    try {
      assertion()
      return
    } catch (err) {
      lastError = err
      if (Date.now() - start >= timeout) throw lastError
      await wait(interval)
    }
  }
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

      await expectEventually(() => {
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
  })

  describe('given a target service that requires retries', () => {
    let currentRetryCount, unboxedService

    // Fail the first 3 attempts so the 4th delivers — see metrics-outbox.test.js for rationale.
    const ATTEMPTS_TO_FAIL = 3

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalServiceOne')

      unboxedService.before('call', req => {
        if ((currentRetryCount[cds.context.tenant] += 1) <= ATTEMPTS_TO_FAIL) {
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

      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T2])
      ])
      // Reference time taken after GETs return — i.e. after both messages are persisted in the outbox.
      const timeOfInitialCall = Date.now()

      // Wait for both tenants to make their second attempt (= first retry).
      await expectEventually(() => {
        expect(currentRetryCount[T1]).to.be.gte(2)
        expect(currentRetryCount[T2]).to.be.gte(2)
      })

      // The storage_time gauges need a real second to elapse since the messages were enqueued —
      // this is the one place the test fundamentally depends on wall-clock time.
      const elapsed = Date.now() - timeOfInitialCall
      if (elapsed < 1500) await wait(1500 - elapsed)

      await expectEventually(() => {
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
      })

      // Final attempt — the message is delivered and removed from the outbox.
      await expectEventually(() => {
        expect(currentRetryCount[T1]).to.be.gte(ATTEMPTS_TO_FAIL + 1)
        expect(currentRetryCount[T2]).to.be.gte(ATTEMPTS_TO_FAIL + 1)

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
  })

  describe('given a taget service that fails unrecoverably', () => {
    let unboxedService

    beforeAll(async () => {
      unboxedService = await cds.connect.to('ExternalServiceOne')

      unboxedService.before('call', req => {
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

      await expectEventually(() => {
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
})
