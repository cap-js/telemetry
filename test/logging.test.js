/* eslint-disable no-console */

// REVISIT: even with profile "logging", cls_custom_fields from package.json wins
process.env.cds_log = JSON.stringify({ cls_custom_fields: ['foo'] })

const cds = require('@sap/cds')
const { expect, GET } = cds.test(__dirname + '/bookshop', '--profile', 'logging')

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
