// Mock console.dir to capture logs ConsoleMetricExporter writes
const consoleDirLogs = []
jest.spyOn(console, 'dir').mockImplementation((...args) => {
  consoleDirLogs.push(args)
})

const E1 = 'ExternalServiceOne'
const E2 = 'ExternalServiceTwo'

const cds = require('@sap/cds')
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

      await wait(300) // Wait for metrics to be collected

      expect(metricValue('cold_entries', E1)).to.eq(0)
      expect(metricValue('remaining_entries', E1)).to.eq(0)
      expect(metricValue('incoming_messages', E1)).to.eq(totalInc[E1])
      expect(metricValue('outgoing_messages', E1)).to.eq(totalOut[E1])
      expect(metricValue('processing_failures', E1)).to.eq(totalFailed[E1])
      expect(metricValue('min_storage_time_in_seconds', E1)).to.eq(0)
      expect(metricValue('med_storage_time_in_seconds', E1)).to.eq(0)
      expect(metricValue('max_storage_time_in_seconds', E1)).to.eq(0)

      await GET('/odata/v4/proxy/proxyCallToExternalServiceTwo', admin)

      await wait(300) // Wait for metrics to be collected

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

  describe('given a target service that requires retries', () => {
    let currentRetryCount, customizedHandler

    const customizedHandlerFor = E => req => {
      if ((currentRetryCount[E] += 1) <= 2) {
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
      const timeOfInitialCall = Date.now()

      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)
      await GET('/odata/v4/proxy/proxyCallToExternalServiceTwo', admin)

      await wait(300) // ... for metrics to be collected
      expect(currentRetryCount[E1]).to.eq(1)

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

      // Wait for the first retry to be initiated
      while (currentRetryCount[E1] < 2) await wait(100)
      while (currentRetryCount[E1] < 2) await wait(100)
      await wait(150) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[E1]).to.eq(2)
      expect(currentRetryCount[E2]).to.eq(2)

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now()
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall))
      }

      await wait(300) // ... for metrics to be collected again

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

      // Wait for the second retry to be initiated
      while (currentRetryCount[E1] < 3) await wait(100)
      await wait(300) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount[E1]).to.eq(3)
      expect(currentRetryCount[E2]).to.eq(3)

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

      await wait(300) // ... for metrics to be collected

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
