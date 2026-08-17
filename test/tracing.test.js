// REVISIT: jest breaks otel's patching of incoming request handling -> we can't ignore via ignoreIncomingRequestHook
process.env.cds_requires_telemetry_tracing_sampler = JSON.stringify({
  ignoreIncomingPaths: ['/odata/v4/admin/Authors']
})

const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

// Assert against the structured ReadableSpan objects captured by MyInMemorySpanExporter
// (configured via the tracing-in-memory profile in test/bookshop/.cdsrc.json) — no
// console spying, no string-regex matching of formatted output.
const { reset, rootSpans, groupedByTrace, captured } = require('./bookshop/lib/MyInMemorySpanExporter')
const otel = require('@opentelemetry/api')

const wait = require('node:timers/promises').setTimeout

// Force-flush the tracer provider's span processor so any spans buffered by background
// activity are exported into `captured`. The global provider is a ProxyTracerProvider (no
// forceFlush) whose delegate is the real NodeTracerProvider; guard for the no-op provider
// so a misconfigured profile fails loudly, not silently.
async function flushSpans() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush()
}

// State-based wait: repeatedly flush + re-run the assertion until it holds or times out.
// Replaces fixed `wait(...)` sleeps that flake on HANA, where spawned/emitted work flushes
// spans after the sleep window.
async function eventually(fn, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  let lastError
  while (true) {
    await flushSpans()
    try {
      await fn()
      return
    } catch (err) {
      lastError = err
      if (Date.now() - start >= timeout) throw lastError
      await wait(interval)
    }
  }
}

// On HANA the persistent-outbox queue poller periodically scans `cds.outbox.Messages` in its
// own `db - tx`, producing an extra root trace that is unrelated to what these tests exercise.
// Filter those bookkeeping traces out so root-count assertions stay stable across both DBs.
const isOutboxScanTrace = g =>
  g.root.name === 'db - tx' && g.all.every(s => s.name === 'db - tx' || s.name.includes('cds.outbox.Messages'))
const meaningfulRoots = () =>
  groupedByTrace()
    .filter(g => !isOutboxScanTrace(g))
    .flatMap(g => g.roots)

describe('tracing', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(reset)

  test('GET is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    // The AdminService READ for Books was traced
    expect(captured.some(s => s.name === 'AdminService - READ AdminService.Books')).to.be.true
    // ...and at least one trace was rooted (i.e. our exporter would emit "elapsed times:")
    expect(rootSpans().length).to.be.gte(1)
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
    // Idempotent cleanup: this file has no data.reset, and on the persistent HANA container a
    // leftover Author 42 from a prior run would make the POST fail with a unique-constraint 500.
    await DELETE.from('sap.capire.bookshop.Authors').where({ ID: 42 })
    reset()
    const { status: postStatus } = await POST('/odata/v4/admin/Authors', { ID: 42, name: 'Douglas Adams' }, admin)
    expect(postStatus).to.equal(201)
    const { status: getStatus } = await GET('/odata/v4/admin/Authors?$select=ID', admin)
    expect(getStatus).to.equal(200)
    // The sampler in this test ignores /odata/v4/admin/Authors — no spans should be captured for it.
    // (Other unrelated background work may still produce spans; assert only that none mention Authors.)
    await eventually(() => {
      expect(captured.filter(s => s.attributes['url.path']?.includes('/admin/Authors'))).to.have.lengthOf(0)
    })
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
    await eventually(() => expect(meaningfulRoots()).to.have.lengthOf(2))
  })

  test('cds.spawn is traced', async () => {
    await POST('/odata/v4/admin/test_spawn', {}, admin)
    // 2 visible roots: the action invocation + the spawned task
    await eventually(() => {
      expect(meaningfulRoots()).to.have.lengthOf(2)
      expect(captured.some(s => s.name === 'cds.spawn - schedule task')).to.be.true
      expect(captured.some(s => s.name === 'cds.spawn - run task')).to.be.true
    })
  })

  test('emit is traced', async () => {
    await POST('/odata/v4/admin/test_emit', {}, admin)
    // local-messaging keeps the consumer in the same context → exactly 1 visible root
    await eventually(() => expect(meaningfulRoots()).to.have.lengthOf(1))
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
    await eventually(() => expect(captured.filter(s => s.name === 'my custom span')).to.have.lengthOf(1))
  })

  // --- TODO ---

  test.skip('individual handlers are traced', async () => {})

  test.skip('remote is traced', async () => {})
})
