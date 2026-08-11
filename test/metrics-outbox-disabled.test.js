const cds = require('@sap/cds')

// With queue metrics disabled (_queue: false in the metrics-outbox-disabled profile) the
// in-memory reader should never capture any `queue.*` datapoints.
const { latestDataPointValue, forceFlush, reset } = require('./bookshop/lib/MyInMemoryMetricReader')

const { expect, GET } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'metrics-outbox-disabled')

function metricValue(metric) {
  return latestDataPointValue(metric)
}

describe('queue metrics is disabled', () => {
  const admin = { auth: { username: 'alice' } }
  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const externalServiceOne = await cds.connect.to('ExternalServiceOne')
    const externalServiceOneQ = cds.outboxed(externalServiceOne)

    proxyService.on('proxyCallToExternalServiceOne', async req => {
      await externalServiceOneQ.send('call', {})
      return req.reply('OK')
    })

    externalServiceOne.before('*', () => {})
  })

  beforeEach(() => reset())

  test('metrics are not collected', async () => {
    await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', admin)

    // Assert absence: with _queue disabled no queue.* instrument is ever registered, so nothing can
    // be exported. Force a few export cycles (rather than a fixed sleep) to give the app every chance
    // to emit a queue metric — none must appear.
    for (let i = 0; i < 5; i++) await forceFlush()

    expect(metricValue('cold_entries')).to.eq(null)
    expect(metricValue('remaining_entries')).to.eq(null)
    expect(metricValue('incoming_messages')).to.eq(null)
    expect(metricValue('outgoing_messages')).to.eq(null)
    expect(metricValue('min_storage_time_in_seconds')).to.eq(null)
    expect(metricValue('med_storage_time_in_seconds')).to.eq(null)
    expect(metricValue('max_storage_time_in_seconds')).to.eq(null)
  })
})
