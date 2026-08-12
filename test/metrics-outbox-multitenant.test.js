const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

// Exported metric data is captured in-memory by MyInMemoryMetricReader (wired via the
// metrics-outbox profile in .cdsrc.json) instead of scraping ConsoleMetricExporter's console.dir.
const { latestDataPointValue, forceFlush, reset } = require('./bookshop/lib/MyInMemoryMetricReader')

const { expect, GET, axios } = cds.test(
  __dirname + '/bookshop',
  '--with-mocks',
  '--profile',
  'metrics-outbox, multitenancy'
)
axios.defaults.validateStatus = () => true

function metricValue(tenant, metric) {
  return latestDataPointValue(metric, { 'sap.tenancy.tenant_id': tenant })
}

// State-based wait: force the wired meter provider to collect + export, then re-run the assertion
// block. Replaces all fixed-time `wait(…)` sleeps — the loop completes the instant the in-memory
// per-tenant queue statistics (kept fresh by the existing cds.spawn poller) reflect the asserted
// state. forceFlush() throws fast if the provider isn't wired, so a misconfigured profile fails
// loudly instead of busy-spinning the full timeout.
async function expectEventually(assertion, { timeout = 10000, interval = 25 } = {}) {
  const start = Date.now()
  let lastError
  while (true) {
    await forceFlush()
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
    reset()
  })

  describe('given the target service succeeds immediately', () => {
    test('metrics are collected per tenant', async () => {
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

    // Fail the first 3 attempts so the 4th delivers — the same widened window #445 introduced for
    // the single-tenant suite: it opens a comfortable gap between "message has aged >=1s in the
    // queue" and "message is delivered and removed", which is what made the wall-clock test flaky.
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
      // Reference time taken BEFORE the GETs so the queuing round-trip counts toward the wall-clock debounce below.
      const timeOfInitialCall = Date.now()
      await Promise.all([
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T1]),
        GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user[T2])
      ])

      // The storage_time gauges need a real second to elapse since the messages were enqueued —
      // this is the one place the test fundamentally depends on wall-clock time.
      const elapsed = Date.now() - timeOfInitialCall
      if (elapsed < 1500) await wait(1500 - elapsed)

      await expectEventually(() => {
        // Message is still being retried (>=1s aged) for both tenants.
        expect(currentRetryCount[T1]).to.be.gte(2)
        expect(currentRetryCount[T2]).to.be.gte(2)

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

      // Final attempt — the message is delivered and removed from the outbox for both tenants.
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
