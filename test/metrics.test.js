// process.env.HOST_METRICS_RETAIN_SYSTEM = 'true' //> with this the test would fail
process.env.HOST_METRICS_LOG_SYSTEM = 'true'
process.env.cds_requires_telemetry_metrics_config = JSON.stringify({ exportIntervalMillis: 100 })

const cds = require('@sap/cds')
const { expect, GET } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

const wait = require('node:timers/promises').setTimeout

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

  test('other metrics with multiple datapoints are logged as array', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)

    await wait(200)

    // nodejs.eventloop.time has multiple datapoints (active + idle) → logged as array
    expect(log.output).to.match(/nodejs\.eventloop\.time: \[/)
    // nodejs.eventloop.utilization has single datapoint → logged unwrapped (not as array)
    expect(log.output).to.match(/nodejs\.eventloop\.utilization: \{/)
  })
})
