// REVISIT: jest breaks otel's patching of incoming request handling -> we can't ignore via ignoreIncomingRequestHook
process.env.cds_requires_telemetry_tracing_sampler = JSON.stringify({
  ignoreIncomingPaths: ['/odata/v4/admin/Authors']
})

const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

// Assert against the structured ReadableSpan objects captured by MyInMemorySpanExporter
// (configured via the tracing-in-memory profile in test/bookshop/.cdsrc.json) — no
// console spying, no string-regex matching of formatted output.
const { reset, rootSpans, captured } = require('./bookshop/lib/MyInMemorySpanExporter')

const wait = require('node:timers/promises').setTimeout

describe('tracing', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(reset)

  test('GET is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    // The AdminService READ for Books was traced
    expect(captured.some(s => s.name === 'AdminService - READ AdminService.Books')).to.be.true
    // ...and at least one trace was rooted (i.e. our exporter would emit "elapsed times:")
    expect(rootSpans()).to.have.lengthOf.at.least(1)
  })

  // REVISIT: jest breaks otel's patching of incoming request handling -> no span for 'GET' -> behavior to test not reproducible
  xtest('GET with traceparent is traced', async () => {
    const config = { ...admin, headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } }
    const { status } = await GET('/odata/v4/admin/Books', config)
    expect(status).to.equal(200)
    expect(captured.some(s => s.name === 'AdminService - READ AdminService.Books')).to.be.true
  })

  test('custom GET is traced', async () => {
    const { status } = await GET('/custom/Books', admin)
    expect(status).to.equal(200)
    expect(captured.some(s => s.name === 'db - READ sap.capire.bookshop.Books')).to.be.true
  })

  test('NonRecordingSpans are handled correctly', async () => {
    const { status: postStatus } = await POST('/odata/v4/admin/Authors', { ID: 42, name: 'Douglas Adams' }, admin)
    expect(postStatus).to.equal(201)
    const { status: getStatus } = await GET('/odata/v4/admin/Authors?$select=ID', admin)
    expect(getStatus).to.equal(200)
    // The sampler in this test ignores /odata/v4/admin/Authors — no spans should be captured for it.
    // (Other unrelated background work may still produce spans; assert only that none mention Authors.)
    expect(captured.filter(s => s.attributes['url.path']?.includes('/admin/Authors'))).to.have.lengthOf(0)
  })

  // REVISIT: jest breaks otel's patching of incoming request handling -> behavior to test not reproducible
  xtest('instrumentation hooks', async () => {})

  test('$batch is traced', async () => {
    await POST(
      '/odata/v4/genre/$batch',
      {
        requests: [
          { id: 'r1', method: 'POST', url: '/Genres', headers: { 'content-type': 'application/json' }, body: {} },
          { id: 'r2', method: 'GET', url: '/Genres', headers: {} }
        ]
      },
      admin
    )
    // With the tx wrap (lib/tracing/cds.js), each batch request's tx becomes a single root —
    // the previously-visible 4 sub-roots (POST: CREATE + read-after-write; GET: read actives +
    // read drafts) are now nested under 2 root tx spans, one per batch entry.
    expect(rootSpans()).to.have.lengthOf(2)
  })

  test('cds.spawn is traced', async () => {
    await POST('/odata/v4/admin/test_spawn', {}, admin)
    await wait(30)
    // 2 visible roots: the action invocation + the spawned task
    expect(rootSpans()).to.have.lengthOf(2)
    expect(captured.some(s => s.name === 'cds.spawn - schedule task')).to.be.true
    expect(captured.some(s => s.name === 'cds.spawn - run task')).to.be.true
  })

  test('emit is traced', async () => {
    await POST('/odata/v4/admin/test_emit', {}, admin)
    await wait(100)
    // local-messaging keeps the consumer in the same context → exactly 1 visible root
    expect(rootSpans()).to.have.lengthOf(1)
  })

  describe('db', () => {
    describe('ql', () => {
      test('SELECT is traced', async () => {
        await SELECT.from('sap.capire.bookshop.Books')
        expect(captured.some(s => s.name === 'db - READ sap.capire.bookshop.Books')).to.be.true
      })
    })

    test('native db statement is traced', async () => {
      const db = await cds.connect.to('db')
      await db.run('SELECT ID, title, stock, price FROM AdminService_Books WHERE ID = 201 OR ID = 207')
      // The wrapper "db - SELECT …" span carries the raw SQL as part of the name.
      expect(captured.some(s => s.name.startsWith('db - SELECT') && s.name.includes('AdminService_Books'))).to.be.true
    })
  })

  test('custom spans are supported', async () => {
    await GET('/odata/v4/catalog/ListOfBooks', {}, admin)
    await wait(100)
    expect(captured.filter(s => s.name === 'my custom span')).to.have.lengthOf(1)
  })

  // --- TODO ---

  test.skip('individual handlers are traced', async () => {})

  test.skip('remote is traced', async () => {})
})
