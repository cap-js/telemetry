process.env.HOST_METRICS_LOG_SYSTEM = 'true'
process.env.cds_requires_outbox = true
process.env.cds_requires_telemetry = JSON.stringify({
  metrics: {
    _outbox: false,
    metrics: { exportIntervalMillis: 100 }
  }
})

const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

const { expect, GET } = cds.test(__dirname + '/bookshop', '--with-mocks')
const log = cds.test.log()

describe('outbox metrics is disabled', () => {
  const admin = { auth: { username: 'alice' } }
  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const externalService = await cds.connect.to('ExternalService')
    const outboxedService = cds.outboxed(externalService)

    proxyService.on('proxyCallToExternalService', async req => {
      await outboxedService.send('call', {})
      return req.reply('OK')
    })

    externalService.before('*', () => {})
  })

  beforeEach(log.clear)

  test('metrics are not collected', async () => {
    await GET('/odata/v4/proxy/proxyCallToExternalService', admin)

    await wait(150) // Wait for metrics to be collected

    expect(log.output.match(/outbox\.cold_entries/)).to.eq(null)
    expect(log.output.match(/outbox\.remaining_entries/)).to.eq(null)
    expect(log.output.match(/outbox\.incoming_messages/)).to.eq(null)
    expect(log.output.match(/outbox\.outgoing_messages/)).to.eq(null)
    expect(log.output.match(/outbox\.min_storage_time_in_seconds/)).to.eq(null)
    expect(log.output.match(/outbox\.med_storage_time_in_seconds/)).to.eq(null)
    expect(log.output.match(/outbox\.max_storage_time_in_seconds/)).to.eq(null)
  })
})
