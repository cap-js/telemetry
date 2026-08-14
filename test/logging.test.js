/* eslint-disable no-console */

// REVISIT: even with profile "logging", cls_custom_fields from package.json wins
process.env.cds_log = JSON.stringify({ cls_custom_fields: ['foo'] })

const cds = require('@sap/cds')
const { expect, GET } = cds.test(__dirname + '/bookshop', '--profile', 'logging')

const wait = require('node:timers/promises').setTimeout

describe('logging', () => {
  const admin = { auth: { username: 'alice' } }

  const { dir } = console
  // The queue's SchedulingService runs an initial outbox scan on server "listening"; its
  // telemetry "elapsed times:" trace primer is exported asynchronously and would otherwise
  // land in the spy window below. Drain it once up front before installing the spy.
  // REVISIT: replace this fixed wait by polling for the primer / an in-memory exporter (see #478).
  beforeAll(() => wait(500))
  beforeEach(() => {
    console.dir = vi.fn()
  })
  afterAll(() => {
    console.dir = dir
  })

  test('it works', async () => {
    const { status } = await GET('/odata/v4/admin/Genres', admin)
    expect(status).to.equal(200)
    // Filter out the queue's outbox-scan "elapsed times:" trace primer. On HANA the outbox
    // poll fires later than the 500ms beforeAll drain, so its primer log can still land in the
    // spy window — but this test is about the 4 real LogRecords, not the trace primer.
    const logs = console.dir.mock.calls.map(([log]) => log).filter(log => !log?.body?.startsWith('elapsed times:'))
    expect(logs.length).to.equal(4)
    expect(logs[0]).to.include({ body: 'GET /odata/v4/admin/Genres ' }) //> why the trailing space?
    expect(logs[1]).to.include({ body: 'Hello, World!' })
    expect(logs[2]).to.containSubset({
      body: "Oh no! Cannot read properties of undefined (reading 'exist')",
      attributes: {
        'log.type': 'LogRecord',
        'exception.message': "Cannot read properties of undefined (reading 'exist')",
        'exception.stacktrace': s => s.match(/^TypeError: .+(\n\s+at .+){5,}$/),
        'exception.type': 'TypeError',
        foo: 'bar'
      }
    })
    expect(logs[3]).to.containSubset({
      body: 'Error-like oh no! Error: dummy',
      attributes: {
        'log.type': 'LogRecord',
        'exception.message': 'dummy',
        'exception.stacktrace': s => s.match(/^Error: .+(\n\s+at .+){5,}$/),
        'exception.type': 'Error',
        foo: 'bar'
      }
    })
  })
})
