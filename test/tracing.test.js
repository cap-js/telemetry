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
const { asExternalClient, eventually, meaningful } = require('./utils')

const meaningfulRoots = () => meaningful(groupedByTrace()).flatMap(g => g.roots)

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

  // With incoming HTTP instrumentation on, the SERVER span adopts the W3C trace context from the
  // request's `traceparent` header: the whole request trace continues the given trace id and the
  // SERVER span is a child of the given (external) span id.
  test('GET with traceparent is traced', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c'
    const parentSpanId = 'b7ad6b7169203331'
    const config = { ...admin, headers: { traceparent: `00-${traceId}-${parentSpanId}-01` } }
    const { status } = await asExternalClient(() => GET('/odata/v4/admin/Books', config))
    expect(status).to.equal(200)
    expect(captured.some(s => s.name === 'AdminService - READ AdminService.Books')).to.be.true
    // The incoming SERVER span continued the propagated trace and parented off the external span id.
    await eventually(() => {
      const server = captured.find(s => s.kind === otel.SpanKind.SERVER && s.spanContext().traceId === traceId)
      expect(server, 'incoming SERVER span adopting the propagated trace').to.exist
      expect(server.parentSpanContext?.spanId).to.equal(parentSpanId)
    })
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

  // Incoming HTTP instrumentation produces a SERVER span (SpanKind.SERVER === 1) per request,
  // carrying the mount-relative `url.path`. Two independent mechanisms suppress that span:
  //   - the sampler's `ignoreIncomingPaths` (set at the top of this file for /odata/v4/admin/Authors)
  //   - the `ignoreIncomingRequestHook` (MyIgnoreIncomingRequestHook: /odata/v4/admin/Authors + /Books(252))
  // A non-ignored path still produces a SERVER span; the ignored paths must produce none.
  test('instrumentation hooks', async () => {
    const serverSpansFor = path =>
      captured.filter(s => s.kind === otel.SpanKind.SERVER && s.attributes['url.path'] === path)

    // Baseline: a non-ignored path DOES yield an incoming SERVER span.
    await asExternalClient(() => GET('/odata/v4/admin/Books', admin))
    await eventually(() => expect(serverSpansFor('/Books')).to.have.lengthOf(1))

    // Sampler path: /odata/v4/admin/Authors is in ignoreIncomingPaths -> no SERVER span.
    reset()
    await asExternalClient(() => GET('/odata/v4/admin/Authors?$select=ID', admin))
    await eventually(() => {
      expect(captured.some(s => s.kind === otel.SpanKind.SERVER && s.attributes['url.path']?.includes('/Authors'))).to
        .be.false
    })

    // ignoreIncomingRequestHook path: /Books(252) is ignored by the hook (not the sampler) -> no SERVER span.
    reset()
    await asExternalClient(() => GET('/odata/v4/admin/Books(252)', admin))
    await eventually(() => {
      expect(serverSpansFor('/Books(252)')).to.have.lengthOf(0)
    })
  })

  test('$batch is traced', async () => {
    await asExternalClient(() =>
      POST(
        '/odata/v4/genre/$batch',
        {
          requests: [
            { id: 'r1', method: 'POST', url: '/Genres', headers: { 'content-type': 'application/json' }, body: {} },
            { id: 'r2', method: 'GET', url: '/Genres', headers: {} }
          ]
        },
        admin
      )
    )
    // With incoming HTTP instrumentation on, the single $batch POST produces one incoming SERVER
    // span that becomes the trace root. Both batch sub-requests (the POST -> CREATE Genres draft
    // and the GET -> READ Genres) run within that request context, so their tx spans reparent
    // under the SERVER span rather than surfacing as separate roots. Result: exactly 1 meaningful
    // root (the SERVER span), containing both the CREATE and the READ sub-operations.
    await eventually(() => {
      const roots = meaningfulRoots()
      expect(roots).to.have.lengthOf(1)
      expect(roots[0].kind).to.equal(otel.SpanKind.SERVER)
      expect(captured.some(s => s.name === 'GenreService - CREATE GenreService.Genres.drafts')).to.be.true
      expect(captured.some(s => s.name === 'GenreService - READ GenreService.Genres')).to.be.true
    })
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
