process.env.cds_requires_telemetry_tracing_exporter_module = '@opentelemetry/sdk-trace-node'

const cds = require('@sap/cds')
const { expect, data } = cds.test().in(__dirname + '/bookshop')
const http = require('http')

describe('tracing attributes', () => {
  beforeEach(data.reset)

  const log = jest.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  describe('remote', () => {
    let server, port

    beforeAll(done => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ value: [] }))
      })
      server.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    afterAll(done => {
      server.close(done)
    })

    test('HTTP client attributes are set on remote service span', async () => {
      // skip for cds 8 due to Cloud SDK resilience module resolution issues in test environment
      if (cds.version.split('.')[0] < 9) return

      // configure destination URL directly on credentials
      cds.env.requires.TestRemote = { kind: 'odata', credentials: { url: `http://localhost:${port}` } }
      const remote = await cds.connect.to('TestRemote')

      // no mock handler - let it make the actual HTTP call
      await remote.send({ method: 'GET', path: '/test' })

      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/"http\.request\.method":"GET"/)
      expect(output).to.match(/"http\.response\.status_code":200/)
      expect(output).to.match(new RegExp(`"url\\.full":"http://localhost:${port}/test"`))
      expect(output).to.match(/"server\.address":"localhost"/)
      expect(output).to.match(new RegExp(`"server\\.port":${port}`))
    })
  })

  describe('db', () => {
    const _db_spans = require('./_db_spans')
    // prettier-ignore
    const _get_db_spans = o => JSON.parse(o).map(o => o[0]).filter(s => !s.name.startsWith('db'))
    const _match_db_spans = (output, kind) => {
      const db_spans = _get_db_spans(output)
      for (const each of _db_spans[kind]) expect(db_spans).to.containSubset([each])
    }

    test('SELECT', async () => {
      await SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
      _match_db_spans(output, 'SELECT')
    })

    test('INSERT', async () => {
      await INSERT.into('sap.capire.bookshop.Books').entries([{ ID: 1 }, { ID: 2 }])
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":2/)
      // TODO
      // _match_db_spans(output, 'INSERT')
    })

    test('UPDATE', async () => {
      await UPDATE('sap.capire.bookshop.Books').set({ stock: 42 }).where('ID > 250')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":3/)
      // TODO
      // _match_db_spans(output, 'UPDATE')
    })

    test('DELETE', async () => {
      await DELETE.from('sap.capire.bookshop.Books')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":0/) //> texts
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
      // TODO
      // _match_db_spans(output, 'DELETE')
    })
  })
})
