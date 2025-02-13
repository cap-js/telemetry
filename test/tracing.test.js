// REVISIT: jest breaks otel's patching of incoming request handling -> we can't ignore via ignoreIncomingRequestHook
process.env.cds_requires_telemetry_tracing_sampler = JSON.stringify({
  ignoreIncomingPaths: ['/odata/v4/admin/Authors']
})

const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

const sleep = require('util').promisify(setTimeout)

describe('tracing', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(log.clear)

  test('GET is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
    expect(log.output).to.match(/\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* AdminService - READ AdminService.Books/)
  })

  // REVISIT: jest breaks otel's patching of incoming request handling -> no span for 'GET' -> behavior to test not reproducible
  xtest('GET with traceparent is traced', async () => {
    const config = { ...admin, headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } }
    const { status } = await GET('/odata/v4/admin/Books', config)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
    expect(log.output).to.match(/\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* AdminService - READ AdminService.Books/)
  })

  test('NonRecordingSpans are handled correctly', async () => {
    const { status: postStatus } = await POST('/odata/v4/admin/Authors', { ID: 42, name: 'Douglas Adams' }, admin)
    expect(postStatus).to.equal(201)
    const { status: getStatus } = await GET('/odata/v4/admin/Authors?$select=ID', admin)
    expect(getStatus).to.equal(200)
    // primitive check that console has no trace logs
    expect(log.output).not.to.match(/telemetry/)
  })

  // REVISIT: jest breaks otel's patching of incoming request handling -> behavior to test not reproducible
  xtest('instrumentation hooks', async () => {
    await GET('/odata/v4/admin/Books(251)', admin)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
    log.clear()
    await GET('/odata/v4/admin/Books(252)', admin)
    // primitive check that console has no trace logs
    expect(log.output).not.to.match(/telemetry/)
  })

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
    // 4: POST: create/ new + read after write, GET: read actives + read drafts
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4)
  })

  test('cds.spawn is traced', async () => {
    await POST('/odata/v4/admin/test_spawn', {}, admin)
    await sleep(30)
    // 2: action + spawned action
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(2)
  })

  test('emit is traced', async () => {
    await POST('/odata/v4/admin/test_emit', {}, admin)
    await sleep(100)
    // 1: local-messaging remains in same context
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(1)
  })

  describe('db', () => {
    describe('ql', () => {
      test('SELECT is traced', async () => {
        await SELECT.from('sap.capire.bookshop.Books')
        // primitive check that console has trace logs
        expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
        expect(log.output).to.match(
          /\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* db - READ sap\.capire\.bookshop\.Books/
        )
      })
    })

    test('native db statement is traced', async () => {
      const db = await cds.connect.to('db')
      await db.run('SELECT ID, title, stock, price FROM AdminService_Books WHERE ID = 201 OR ID = 207')
      // primitive check that console has trace logs
      expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
      expect(log.output).to.match(
        /\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* db - SELECT .* FROM AdminService_Books WHERE ID = 201 OR I…/
      )
    })
  })

  test('custom spans are supported', async () => {
    await GET('/odata/v4/catalog/ListOfBooks', {}, admin)
    await sleep(100)
    expect(log.output.match(/my custom span/g).length).to.equal(1)
  })

  // --- TODO ---

  test.skip('individual handlers are traced', async () => {})

  test.skip('remote is traced', async () => {})
})
