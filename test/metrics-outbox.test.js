import { vi } from 'vitest'

const E1 = 'ExternalServiceOne'
const E2 = 'ExternalServiceTwo'

const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

// Exported metric data is captured in-memory by MyInMemoryMetricReader (wired via the
// metrics-outbox profile in .cdsrc.json) instead of scraping ConsoleMetricExporter's console.dir.
const { latestDataPointValue, forceFlush, reset } = require('./bookshop/lib/MyInMemoryMetricReader')
const { clearOutbox, makeExpectEventually } = require('./bookshop/lib/test-utils')

const { expect, GET, axios } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'metrics-outbox')
axios.defaults.validateStatus = () => true

function metricValue(metric, queuedServiceName) {
  return latestDataPointValue(metric, { 'queue.name': queuedServiceName })
}

// State-based wait for metric assertions: force the wired meter provider (forceFlush) to collect +
// export, then re-run the assertion block. Replaces all fixed-time `wait(150)` sleeps — the loop
// completes the instant the in-memory queue statistics (kept fresh by the queue-stats cds.spawn
// poller) reflect the asserted state. forceFlush() throws fast if the provider isn't wired, so a
// misconfigured profile fails loudly instead of busy-spinning the full timeout.
//
// interval is 500ms (NOT a few ms): each forceFlush() triggers a metric collection that runs the
// queue-stats poller's SELECTs against the DB. On the SHARED HANA HDI container a tight poll loop
// (plus the profile's background export) starves the queue worker of connections, so its retries
// stall and delivery never completes — which manifested as `expected N to be at least M` flakes
// and, via ensuing hook hangs + pool exhaustion, ECONNREFUSED cascades into later files' servers.
// Polling at 500ms (with the profile's exportIntervalMillis raised to 1000ms) leaves the worker
// enough DB headroom to make all its attempts. The loop still returns the instant the state holds,
// so sqlite (per-file in-memory DB) still satisfies in well under a second.
const expectEventually = makeExpectEventually(forceFlush, { timeout: 30000, interval: 500 })

const debugLog = (cds.log('telemetry').debug = vi.fn(() => {}))

describe('queue metrics for single tenant service', () => {
  let totalInc = { [E1]: 0, [E2]: 0 }
  let totalOut = { [E1]: 0, [E2]: 0 }
  let totalFailed = { [E1]: 0, [E2]: 0 }

  let externalServiceOne, externalServiceTwo

  const admin = { auth: { username: 'alice' } }

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')

    externalServiceOne = await cds.connect.to(E1)
    const externalServiceOneQ = cds.queued(externalServiceOne)

    externalServiceTwo = await cds.connect.to(E2)
    const externalServiceTwoQ = cds.queued(externalServiceTwo)

    proxyService.on('proxyCallToExternalServiceOne', async req => {
      totalInc[E1] += 1
      await externalServiceOneQ.send('call', {})
      return req.reply('OK')
    })

    proxyService.on('proxyCallToExternalServiceTwo', async req => {
      totalInc[E2] += 1
      await externalServiceTwoQ.send('call', {})
      return req.reply('OK')
    })

    // Register handler to avoid error due to unhandled action
    externalServiceOne.on('call', req => req.reply('OK'))
    externalServiceTwo.on('call', req => req.reply('OK'))

    externalServiceOne.before('*', () => {
      totalOut[E1] += 1
    })
    externalServiceTwo.before('*', () => {
      totalOut[E2] += 1
    })
  })

  beforeEach(async () => {
    await clearOutbox()
    reset()
    debugLog.mockClear()
  })

  // Leave the shared DB clean for the next test file and let background queue workers settle.
  // On HANA all files share one HDI container, so (a) the undeliverable `unknown-service` row
  // inserted by the last case below would otherwise linger and skew another file's queue metrics,
  // and (b) an in-flight worker retrying a message could fire this file's `before('call')` handler
  // during teardown. Clear, wait a beat for any in-flight worker iteration to finish, clear again.
  // Every clear is timeout-bounded (clearOutbox) so a draining pool can't hang the hook. HANA-only:
  // sqlite gets a fresh in-memory DB per file, so the settle is pointless there.
  afterAll(async () => {
    await clearOutbox()
    if (process.env.TELEMETRY_TEST_HANA) {
      await wait(5000)
      await clearOutbox()
    }
  })

  describe('given the target service succeeds immediately', () => {
    test('metrics are collected', async () => {
      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)

      await expectEventually(() => {
        expect(metricValue('cold_entries', E1)).to.eq(0)
        expect(metricValue('remaining_entries', E1)).to.eq(0)
        expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
        expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
        expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
        expect(metricValue('min_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E1)).to.eq(0)
      })

      await GET('/odata/v4/proxy/proxyCallToExternalServiceTwo', admin)

      await expectEventually(() => {
        expect(metricValue('cold_entries', E2)).to.eq(0)
        expect(metricValue('remaining_entries', E2)).to.eq(0)
        expect(metricValue('incoming_messages', E2)).to.eq(totalInc[E2])
        expect(metricValue('outgoing_messages', E2)).to.eq(totalOut[E2])
        expect(metricValue('processing_failures', E2)).to.eq(totalFailed[E2])
        expect(metricValue('min_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E2)).to.eq(0)
      })
    })
  })

  describe('given a target service that requires retries', () => {
    // Initialized at declaration (not left undefined): the `before('call')` handler registered in
    // beforeAll stays live for the whole describe, so a background queue-worker retry can fire it
    // OUTSIDE any test's window (between tests, or during teardown). If currentRetryCount were
    // undefined then, `currentRetryCount[E]` throws — the queue logs "Programming error detected"
    // and the delivery the test expects never completes. On HANA the slower retry cadence + pool
    // drain at teardown reliably hits that gap; sqlite's timing never exposed it. beforeEach still
    // re-zeroes it per test.
    let currentRetryCount = { [E1]: 0, [E2]: 0 }
    let customizedHandler

    // Fail the first 3 attempts so the 4th delivers. With the queue's exp-backoff schedule
    // (0.5s, 1.25s, 2.375s, ...), this places the 4th attempt at ~t=4.1s after enqueue —
    // giving a comfortable ~3s window between "message has aged 1s in the queue" and
    // "message is finally delivered and removed". Tightening that window is what made the
    // original wall-clock-based test flaky.
    const ATTEMPTS_TO_FAIL = 3
    const customizedHandlerFor = E => req => {
      if ((currentRetryCount[E] += 1) <= ATTEMPTS_TO_FAIL) {
        totalFailed[E] += 1
        return req.reject({ status: 503 })
      }
    }

    beforeAll(() => {
      customizedHandler = {
        [E1]: customizedHandlerFor(E1),
        [E2]: customizedHandlerFor(E2)
      }

      externalServiceOne.before('call', req => customizedHandler[E1](req))
      externalServiceTwo.before('call', req => customizedHandler[E2](req))
    })

    afterAll(() => {
      customizedHandler = {
        [E1]: () => {},
        [E2]: () => {}
      }
    })

    beforeEach(() => {
      currentRetryCount = { [E1]: 0, [E2]: 0 }
    })

    test('storage time increases before message can be delivered', async () => {
      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)
      await GET('/odata/v4/proxy/proxyCallToExternalServiceTwo', admin)
      // Reference time taken after GETs return — i.e. after both messages are persisted in the outbox.
      const timeOfInitialCall = Date.now()

      // Freshly-enqueued state: each message is present (remaining == 1) and not cold. We assert
      // each service in its OWN poll (E1 and E2 stagger; coupling them risks one aging out before
      // the other aligns). Storage_time is asserted as a small upper bound rather than exactly 0:
      // the "just enqueued, ~0s old" state is a sub-second transient and on HANA the queue-stats
      // poller's first observation already lands with storage_time >= 1 (poll interval + query
      // latency), so `== 0` is not reliably observable. The `< 60` bound still guards the timezone
      // regression this suite covers (a naive-timestamp misparse reported storage_time as ~7200s);
      // storage-time GROWTH is asserted in the next block, delivery/removal in the one after.
      const assertFreshlyEnqueued = E =>
        expectEventually(() => {
          expect(metricValue('cold_entries', E)).to.eq(0)
          expect(metricValue('remaining_entries', E)).to.eq(1)
          expect(metricValue('incoming_messages', E)).to.eq(totalInc[E])
          expect(metricValue('outgoing_messages', E)).to.eq(totalOut[E])
          expect(metricValue('processing_failures', E)).to.eq(totalFailed[E])
          expect(metricValue('min_storage_time_in_seconds', E)).to.be.lessThan(60)
          expect(metricValue('med_storage_time_in_seconds', E)).to.be.lessThan(60)
          expect(metricValue('max_storage_time_in_seconds', E)).to.be.lessThan(60)
        })
      await Promise.all([assertFreshlyEnqueued(E1), assertFreshlyEnqueued(E2)])

      // The storage_time gauges need a real second to elapse since the messages were enqueued —
      // this is the one place the test fundamentally depends on wall-clock time.
      const elapsed = Date.now() - timeOfInitialCall
      if (elapsed < 1500) await wait(1500 - elapsed)

      await expectEventually(() => {
        // Either still on attempt 2 (waiting to retry) or on attempt 3 (delivered) — both are fine
        // for these assertions, the message has been in the queue >=1s either way.
        expect(currentRetryCount[E1]).to.be.gte(2)
        expect(currentRetryCount[E2]).to.be.gte(2)

        expect(metricValue('cold_entries', E1)).to.eq(0)
        expect(metricValue('remaining_entries', E1)).to.eq(1)
        expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
        expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
        expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
        expect(metricValue('min_storage_time_in_seconds', E1)).to.be.gte(1)
        expect(metricValue('med_storage_time_in_seconds', E1)).to.be.gte(1)
        expect(metricValue('max_storage_time_in_seconds', E1)).to.be.gte(1)

        expect(metricValue('cold_entries', E2)).to.eq(0)
        expect(metricValue('remaining_entries', E2)).to.eq(1)
        expect(metricValue('incoming_messages', E2)).to.eq(totalInc[E2])
        expect(metricValue('outgoing_messages', E2)).to.eq(totalOut[E2])
        expect(metricValue('processing_failures', E2)).to.eq(totalFailed[E2])
        expect(metricValue('min_storage_time_in_seconds', E2)).to.be.gte(1)
        expect(metricValue('med_storage_time_in_seconds', E2)).to.be.gte(1)
        expect(metricValue('max_storage_time_in_seconds', E2)).to.be.gte(1)
      })

      // Final attempt — the message is delivered and removed from the outbox.
      await expectEventually(() => {
        expect(currentRetryCount[E1]).to.be.gte(ATTEMPTS_TO_FAIL + 1)
        expect(currentRetryCount[E2]).to.be.gte(ATTEMPTS_TO_FAIL + 1)

        expect(metricValue('cold_entries', E1)).to.eq(0)
        expect(metricValue('remaining_entries', E1)).to.eq(0)
        expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
        expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
        expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
        expect(metricValue('min_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E1)).to.eq(0)

        expect(metricValue('cold_entries', E2)).to.eq(0)
        expect(metricValue('remaining_entries', E2)).to.eq(0)
        expect(metricValue('incoming_messages', E2)).to.eq(totalInc[E2])
        expect(metricValue('outgoing_messages', E2)).to.eq(totalOut[E2])
        expect(metricValue('processing_failures', E2)).to.eq(totalFailed[E2])
        expect(metricValue('min_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E2)).to.eq(0)
      })
    })
  })

  describe('given a target service that fails unrecoverably', () => {
    let customizedHandler

    const customizedHandlerFor = E => req => {
      totalFailed[E] += 1
      return req.reject({ status: 418, unrecoverable: true })
    }

    beforeAll(() => {
      customizedHandler = {
        [E1]: customizedHandlerFor(E1),
        [E2]: customizedHandlerFor(E2)
      }

      externalServiceOne.before('call', req => customizedHandler[E1](req))
      externalServiceTwo.before('call', req => customizedHandler[E2](req))
    })

    afterAll(() => {
      customizedHandler = {
        [E1]: () => {},
        [E2]: () => {}
      }
    })

    test('cold entry is observed', async () => {
      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)
      await GET('/odata/v4/proxy/proxyCallToExternalServiceTwo', admin)

      await expectEventually(() => {
        expect(metricValue('cold_entries', E1)).to.eq(1)
        expect(metricValue('remaining_entries', E1)).to.eq(0)
        expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
        expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
        expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
        expect(metricValue('min_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E1)).to.eq(0)

        expect(metricValue('cold_entries', E2)).to.eq(1)
        expect(metricValue('remaining_entries', E2)).to.eq(0)
        expect(metricValue('incoming_messages', E2)).to.eq(totalInc[E2])
        expect(metricValue('outgoing_messages', E2)).to.eq(totalOut[E2])
        expect(metricValue('processing_failures', E2)).to.eq(totalFailed[E2])
        expect(metricValue('min_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E2)).to.eq(0)
      })
    })
  })

  describe('given someone tries to interact with the persistent outbox table directly', () => {
    describe('app should not crash', () => {
      test('when a message targeting an unknown service is added to the persistent outbox table manually', async () => {
        try {
          await INSERT.into('cds.outbox.Messages').entries({
            ID: cds.utils.uuid(),
            target: 'unknown-service'
          })
        } catch (e) {
          expect.fail(`Did not expect an error here: ${e.message}`)
        }

        expect(debugLog.mock.calls.some(log => log[0].match(/unknown service/i))).to.be.true
      })
    })
  })
})
