/* eslint-disable no-console */

process.env.cds_log_format = 'json'

process.env.cds_requires_telemetry = JSON.stringify({
  instrumentations: {
    http: { config: { ignoreIncomingPaths: ['/odata/v4/admin/Genres'] } }
  },
  logging: {
    exporter: {
      module: '@opentelemetry/sdk-logs',
      class: 'ConsoleLogRecordExporter'
    },
    custom_fields: ['foo'],
    // experimental feature of the experimental feature!!!
    processor: {
      module: './lib/MySimpleLogRecordProcessor.js',
      class: 'MySimpleLogRecordProcessor'
    }
  }
})

const cds = require('@sap/cds')
const { expect, GET } = cds.test().in(__dirname + '/bookshop')

describe('logging', () => {
  const admin = { auth: { username: 'alice' } }

  const { dir } = console
  beforeEach(() => {
    console.dir = jest.fn()
  })
  afterAll(() => {
    console.dir = dir
  })

  test('it works', async () => {
    const { status } = await GET('/odata/v4/admin/Genres', admin)
    expect(status).to.equal(200)
    const logs = console.dir.mock.calls.map(([log]) => log)
    expect(logs.length).to.equal(3)
    expect(logs[0]).to.include({ body: 'GET /odata/v4/admin/Genres ' }) //> why the trailing space?
    expect(logs[1]).to.include({ body: 'Hello, World!' })
    expect(logs[2]).to.deep.include({
      body: "Oh no! Cannot read properties of undefined (reading 'exist')",
      attributes: {
        'log.type': 'LogRecord',
        'exception.message': "Cannot read properties of undefined (reading 'exist')",
        'exception.stacktrace':
          `TypeError: Cannot read properties of undefined (reading 'exist')
    at AdminService.exist (${cds.root}/srv/admin-service.js:16:21)
    at ${cds.home}/lib/srv/srv-dispatch.js:59:59
    at Array.map (<anonymous>)
    at AdminService.handle (${cds.home}/lib/srv/srv-dispatch.js:59:33)
    at processTicksAndRejections (node:internal/process/task_queues:105:5)
    at AdminService.handle (${cds.home}/libx/_runtime/common/Service.js:84:16)`,
        'exception.type': 'TypeError',
        foo: 'bar'
      }
    })
  })
})
