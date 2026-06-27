// Capture exported metric data via ConsoleMetricExporter's console.dir output
const consoleDirLogs = []
jest.spyOn(console, 'dir').mockImplementation((...args) => {
  consoleDirLogs.push(args)
})

const E1 = 'ExternalServiceOne'
const E2 = 'ExternalServiceTwo'

const cds = require('@sap/cds')
const { metrics } = require('@opentelemetry/api')
const { setTimeout: wait } = require('node:timers/promises')

const { expect, GET, axios } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'metrics-outbox')
axios.defaults.validateStatus = () => true

function metricValue(metric, queuedServiceName) {
  const mostRecentMetricLog = consoleDirLogs.findLast(
    metricLog => metricLog[0].descriptor.name === `queue.${metric}` && metricLog[0].dataPoints?.length
  )?.[0]

  const mestRecentQueueMetricData = mostRecentMetricLog?.dataPoints.find(
    dataPoint => dataPoint.attributes['queue.name'] === queuedServiceName
  )

  if (!mestRecentQueueMetricData) return null

  return mestRecentQueueMetricData.value
}

// State-based wait: force the metric provider to export, then re-run the assertion block.
// Replaces all fixed-time `wait(150)` sleeps — the loop completes the instant the in-memory
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

const debugLog = (cds.log('telemetry').debug = jest.fn(() => {}))

describe('queue metrics for single tenant service', () => {
  if (cds.version.split('.')[0] < 9) {
    test.skip('skipping tests for cds version < 9', () => {})
    return
  }

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
    await DELETE.from('cds.outbox.Messages')
    consoleDirLogs.length = 0
    debugLog.mockClear()
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
    let currentRetryCount, customizedHandler

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

      // The queue has made its first delivery attempt for both services (handler invocation count is
      // observed directly via the rejecting `before('call')` handler — pure CAP event observation).
      await expectEventually(() => {
        expect(currentRetryCount[E1]).to.be.gte(1)
        expect(currentRetryCount[E2]).to.be.gte(1)

        expect(metricValue('cold_entries', E1)).to.eq(0)
        expect(metricValue('remaining_entries', E1)).to.eq(1)
        expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
        expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
        expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
        expect(metricValue('min_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E1)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E1)).to.eq(0)

        expect(metricValue('cold_entries', E2)).to.eq(0)
        expect(metricValue('remaining_entries', E2)).to.eq(1)
        expect(metricValue('incoming_messages', E2)).to.eq(totalInc[E2])
        expect(metricValue('outgoing_messages', E2)).to.eq(totalOut[E2])
        expect(metricValue('processing_failures', E2)).to.eq(totalFailed[E2])
        expect(metricValue('min_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('med_storage_time_in_seconds', E2)).to.eq(0)
        expect(metricValue('max_storage_time_in_seconds', E2)).to.eq(0)
      })

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
