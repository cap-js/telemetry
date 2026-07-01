const cds = require('@sap/cds')
const { expect, data } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-attributes')
const { SELECT, INSERT } = cds.ql
const http = require('http')

describe('span names', () => {
  beforeEach(data.reset)

  const log = jest.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  const getSpans = () => log.mock.calls.map(c => c[0]).filter(Boolean)

  // Spans from our tracer only (excludes HTTP instrumentation spans)
  const getCapSpans = () => getSpans().filter(s => s.instrumentationScope?.name === '@cap-js/telemetry')
  const capSpanNames = () => getCapSpans().map(s => s.name)

  describe('db', () => {
    test('SELECT: inner DB span name uses operation+table, not SQL', async () => {
      await SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')
      const names = capSpanNames()
      // outer CAP span: event+target (unchanged)
      expect(names).to.include('db - READ sap.capire.bookshop.Books')
      // inner SQLite prepare span: SQL verb + table appended, not raw SQL
      expect(names.some(n => /^@cap-js\/\w+ - prepare SELECT sap\.capire\.bookshop\.Books$/.test(n))).to.be.true
      // no span name should carry raw SQL
      for (const name of names) {
        expect(name, `span "${name}" contains SQL`).not.to.match(/SELECT\s|json_insert|INSERT\s+INTO|UPDATE\s+\w/)
      }
    })

    test('SELECT: inner DB span has db.query.text attribute with SQL', async () => {
      await SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')
      const spans = getCapSpans()
      const prepareSpan = spans.find(s => /^@cap-js\/\w+ - prepare /.test(s.name))
      expect(prepareSpan).to.exist
      // SQL lives in the attribute, not the name
      expect(prepareSpan.attributes['db.query.text']).to.match(/SELECT/)
      expect(prepareSpan.attributes['db.operation.name']).to.equal('READ')
      expect(prepareSpan.attributes['db.sql.table']).to.equal('sap.capire.bookshop.Books')
    })

    test('raw SQL via db.run: span name preserves the SQL string', async () => {
      const db = await cds.connect.to('db')
      await db.run('SELECT ID, title FROM sap_capire_bookshop_Books WHERE ID = 201')
      const names = capSpanNames()
      // _getSpanName: event === undefined path -> "db - <sql>"
      expect(names.some(n => n.startsWith('db - SELECT'))).to.be.true
    })

    test('INSERT: inner DB span name uses operation+table, not SQL', async () => {
      await INSERT.into('sap.capire.bookshop.Books').entries([{ ID: 999 }])
      const names = capSpanNames()
      expect(names).to.include('db - CREATE sap.capire.bookshop.Books')
      for (const name of names) {
        expect(name, `span "${name}" contains SQL`).not.to.match(/INSERT\s+INTO|json_insert/)
      }
    })
  })

  describe('cloud sdk', () => {
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

    afterAll(() => new Promise(resolve => server.close(resolve)))

    test('Cloud SDK span name uses destination+method, not URL', async () => {
      // Cloud SDK resilience module resolution issues in cds < 9
      if (Number(cds.version.split('.')[0]) < 9) return

      cds.env.requires.TestRemote = { kind: 'odata', credentials: { url: `http://localhost:${port}` } }
      const remote = await cds.connect.to('TestRemote')
      await remote.send({ method: 'GET', path: '/test' })

      // no CAP-level span name should contain a URL
      for (const name of capSpanNames()) {
        expect(name, `span "${name}" contains URL`).not.to.match(/https?:\/\//)
      }
    })
  })
})
