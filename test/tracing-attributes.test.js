const cds = require('@sap/cds')
const { expect, data } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const http = require('http')

// The tracing-in-memory profile (see test/bookshop/.cdsrc.json) configures
// MyInMemorySpanExporter as the trace exporter. We read the captured ReadableSpan
// objects directly out of its shared buffer — no console spy, no provider-poking.
const { captured } = require('./bookshop/lib/MyInMemorySpanExporter')

beforeEach(async () => {
  // data.reset is itself heavily traced (it runs DELETEs + INSERTs for the seed data) —
  // run it first, THEN clear the buffer so the test only sees its own spans.
  await data.reset()
  captured.length = 0
})

// Returns all finished spans, optionally filtered by a predicate.
const spans = filter => (filter ? captured.filter(filter) : captured.slice())

describe('tracing attributes', () => {
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
      if (Number(cds.version.split('.')[0]) < 9) return

      // configure destination URL directly on credentials
      cds.env.requires.TestRemote = { kind: 'odata', credentials: { url: `http://localhost:${port}` } }
      const remote = await cds.connect.to('TestRemote')

      // no mock handler - let it make the actual HTTP call
      await remote.send({ method: 'GET', path: '/test' })

      // Find the HTTP client span (instrumented by OTel's http instrumentation)
      const httpSpan = spans(s => s.attributes['http.request.method'] === 'GET' && s.attributes['url.full'])
      expect(httpSpan, 'expected an HTTP client span').to.have.lengthOf.at.least(1)
      const attrs = httpSpan[0].attributes
      expect(attrs).to.include({
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'url.full': `http://localhost:${port}/test`,
        'server.address': 'localhost',
        'server.port': port
      })
    })
  })

  describe('db', () => {
    const _db_spans = require('./_db_spans')

    // Filter out the high-level "db - …" CAP wrapper spans, keep only the @cap-js/<driver> ones
    // that carry the actual DB attributes.
    const dbSpans = () => spans(s => !s.name.startsWith('db'))

    const _match_db_spans = kind => {
      const got = dbSpans().map(s => ({ name: s.name, attributes: { ...s.attributes } }))
      for (const each of _db_spans[kind]) expect(got).to.containSubset([each])
    }

    test('SELECT', async () => {
      await SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')
      const rowCounts = dbSpans().map(s => s.attributes['db.client.response.returned_rows']).filter(v => v != null)
      expect(rowCounts).to.include(5)
      _match_db_spans('SELECT')
    })

    test('INSERT', async () => {
      await INSERT.into('sap.capire.bookshop.Books').entries([{ ID: 1 }, { ID: 2 }])
      const rowCounts = dbSpans().map(s => s.attributes['db.client.response.returned_rows']).filter(v => v != null)
      expect(rowCounts).to.include(2)
      // TODO
      // _match_db_spans('INSERT')
    })

    test('UPDATE', async () => {
      await UPDATE('sap.capire.bookshop.Books').set({ stock: 42 }).where('ID > 250')
      const rowCounts = dbSpans().map(s => s.attributes['db.client.response.returned_rows']).filter(v => v != null)
      expect(rowCounts).to.include(3)
      // TODO
      // _match_db_spans('UPDATE')
    })

    test('DELETE', async () => {
      await DELETE.from('sap.capire.bookshop.Books')
      const rowCounts = dbSpans().map(s => s.attributes['db.client.response.returned_rows']).filter(v => v != null)
      expect(rowCounts).to.include(0) // texts
      expect(rowCounts).to.include(5)
      // TODO
      // _match_db_spans('DELETE')
    })
  })
})
