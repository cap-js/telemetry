/* eslint-disable no-console */

process.env.cds_log = JSON.stringify({
  format: 'json',
  cls_custom_fields: ['foo']
})

process.env.cds_requires_telemetry = JSON.stringify({
  tracing: {
    sampler: {
      ignoreIncomingPaths: ['/odata/v4/admin/Genres']
    }
  },
  logging: {
    exporter: {
      module: '@opentelemetry/sdk-logs',
      class: 'ConsoleLogRecordExporter'
    },
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
    expect(logs[2]).to.containSubset({
      body: "Oh no! Cannot read properties of undefined (reading 'exist')",
      attributes: {
        'log.type': 'LogRecord',
        'exception.message': "Cannot read properties of undefined (reading 'exist')",
        'exception.stacktrace': s => s.match(/^TypeError: .+(\n\s+at .+){5}$/),
        'exception.type': 'TypeError',
        foo: 'bar'
      }
    })
  })
})
