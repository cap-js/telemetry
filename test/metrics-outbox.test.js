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
  '--profile', 'metrics-outbox'
)
axios.defaults.validateStatus = () => true

function metricValue(metric) {
  const mostRecentMetricLog = consoleDirLogs.findLast(
    metricLog => metricLog[0].descriptor.name === `queue.${metric}`
  )?.[0]
  
  if (!mostRecentMetricLog) return null
  
  return mostRecentMetricLog.dataPoints[0].value
}

const debugLog = cds.log('telemetry').debug = jest.fn(() => {})

describe('queue metrics for single tenant service', () => {
  let totalInc = { E1: 0, E2: 0 }
  let totalOut = { E1: 0, E2: 0 }
  let totalFailed = { E1: 0, E2: 0 }

  const admin = { auth: { username: 'alice' } }

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')

    const externalServiceOne = await cds.connect.to('ExternalServiceOne')
    const externalServiceOneQ = cds.queued(externalServiceOne)

    const externalServiceTwo = await cds.connect.to('ExternalServiceTwo')
    const externalServiceTwoQ = cds.queued(externalServiceTwo)

    proxyService.on('proxyCallToExternalServiceOne', async req => {
      totalInc.E1 += 1
      await externalServiceOneQ.send('call', {})
      return req.reply('OK')
    })

    proxyService.on('proxyCallToExternalServiceTwo', async req => {
      totalInc.E2 += 1
      await externalServiceTwoQ.send('call', {})
      return req.reply('OK')
    })

    // Register handler to avoid error due to unhandled action
    externalServiceOne.on('call', req => req.reply('OK'))
    externalServiceTwo.on('call', req => req.reply('OK'))

    externalServiceOne.before('*', () => { totalOut.E1 += 1 })
    externalServiceTwo.before('*', () => { totalOut.E2 += 1 })
  })

  beforeEach(async () => {
    await DELETE.from('cds.outbox.Messages')
    consoleDirLogs.length = 0
    debugLog.mockClear()
  })

  describe('given the target service succeeds immediately', () => {

    test('metrics are collected', async () => {
      if (cds.version.split('.')[0] < 9) return

      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)

      await wait(300) // Wait for metrics to be collected

      expect(metricValue('cold_entries')).to.eq(0)
      expect(metricValue('remaining_entries')).to.eq(0)
      expect(metricValue('incoming_messages')).to.eq(totalInc.E1)
      expect(metricValue('outgoing_messages')).to.eq(totalOut.E1)
      expect(metricValue('processing_failures')).to.eq(totalFailed.E1)
      expect(metricValue('min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given a target service that requires retries', () => {
    let currentRetryCount, externalServiceOne

    beforeAll(async () => {
      externalServiceOne = await cds.connect.to('ExternalServiceOne')

      externalServiceOne.before('call', req => {
        if ((currentRetryCount.E1 += 1) <= 2) {
          totalFailed.E1 += 1
          return req.reject({ status: 503 })
        }
      })
    })

    afterAll(async () => {
      externalServiceOne.handlers.before = externalServiceOne.handlers.before.filter(handler => handler.before !== 'call')
    })

    beforeEach(() => {
      currentRetryCount = { E1: 0, E2: 0}
    })

    test('storage time increases before message can be delivered', async () => {
      if (cds.version.split('.')[0] < 9) return

      const timeOfInitialCall = Date.now()
      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)

      await wait(500) // ... for metrics to be collected
      expect(currentRetryCount.E1).to.eq(1)

      expect(metricValue('cold_entries')).to.eq(0)
      expect(metricValue('remaining_entries')).to.eq(1)
      expect(metricValue('incoming_messages')).to.eq(totalInc.E1)
      expect(metricValue('outgoing_messages')).to.eq(totalOut.E1)
      expect(metricValue('processing_failures')).to.eq(totalFailed.E1)
      expect(metricValue('min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('max_storage_time_in_seconds')).to.eq(0)

      // Wait for the first retry to be initiated
      while (currentRetryCount.E1 < 2) await wait(100)
      await wait(150) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount.E1).to.eq(2)

      // Wait until at least 1 second has passed since the initial call
      const timeAfterFirstRetry = Date.now()
      if (timeAfterFirstRetry - timeOfInitialCall < 1000) {
        await wait(1000 - (timeAfterFirstRetry - timeOfInitialCall))
      }

      await wait(150) // ... for metrics to be collected again

      expect(metricValue('cold_entries')).to.eq(0)
      expect(metricValue('remaining_entries')).to.eq(1)
      expect(metricValue('incoming_messages')).to.eq(totalInc.E1)
      expect(metricValue('outgoing_messages')).to.eq(totalOut.E1)
      expect(metricValue('processing_failures')).to.eq(totalFailed.E1)
      expect(metricValue('min_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue('med_storage_time_in_seconds')).to.be.gte(1)
      expect(metricValue('max_storage_time_in_seconds')).to.be.gte(1)

      // Wait for the second retry to be initiated
      while (currentRetryCount.E1 < 3) await wait(100)
      await wait(150) // ... for the retry to be processed and metrics to be collected
      expect(currentRetryCount.E1).to.eq(3)

      expect(metricValue('cold_entries')).to.eq(0)
      expect(metricValue('remaining_entries')).to.eq(0)
      expect(metricValue('incoming_messages')).to.eq(totalInc.E1)
      expect(metricValue('outgoing_messages')).to.eq(totalOut.E1)
      expect(metricValue('processing_failures')).to.eq(totalFailed.E1)
      expect(metricValue('min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given a target service that fails unrecoverably', () => {
    let externalServiceOne

    beforeAll(async () => {
      externalServiceOne = await cds.connect.to('ExternalServiceOne')

      externalServiceOne.before('call', req => {
        totalFailed.E1 += 1
        return req.reject({ status: 418, unrecoverable: true })
      })
    })

    afterAll(async () => {
      externalServiceOne.handlers.before = externalServiceOne.handlers.before.filter(handler => handler.before !== 'call')
    })

    test('cold entry is observed', async () => {
      if (cds.version.split('.')[0] < 9) return

      await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)

      await wait(300) // ... for metrics to be collected

      expect(metricValue('cold_entries')).to.eq(1)
      expect(metricValue('remaining_entries')).to.eq(0)
      expect(metricValue('incoming_messages')).to.eq(totalInc.E1)
      expect(metricValue('outgoing_messages')).to.eq(totalOut.E1)
      expect(metricValue('processing_failures')).to.eq(totalFailed.E1)
      expect(metricValue('min_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('med_storage_time_in_seconds')).to.eq(0)
      expect(metricValue('max_storage_time_in_seconds')).to.eq(0)
    })
  })

  describe('given someone tries to interact with the persistent outbox table directly', () => {
    describe('app should not crash', () => {

      test('when a message targeting an unknown service is added to the persistent outbox table manually', async () => {  
        if (cds.version.split('.')[0] < 9) return

        try {
          await INSERT.into('cds.outbox.Messages').entries({ ID: cds.utils.uuid(), target: 'unknown-service' })
        } catch (e) {
          expect.fail(`Did not expect an error here: ${e.message}`)
        }

        expect(debugLog.mock.calls.some(log => log[0].match(/unknown service/i))).to.be.true
      })
    })
  })
})
