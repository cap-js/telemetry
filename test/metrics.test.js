const cds = require('@sap/cds')

// process.env.HOST_METRICS_RETAIN_SYSTEM = 'true' //> with this the test would fail
process.env.HOST_METRICS_LOG_SYSTEM = 'true'
cds.env.requires.telemetry.metrics.config.exportIntervalMillis = 100

const { expect, GET } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

const wait = require('util').promisify(setTimeout)

describe('metrics', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(log.clear)

  test('system metrics are not collected by default', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    
    await wait(100)

    expect(log.output).to.match(/process/i)
    expect(log.output).not.to.match(/network/i)
  })
})
