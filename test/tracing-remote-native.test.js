// Force CAP to use native fetch for outbound remote calls (instead of the cloud sdk).
// This must be set before @sap/cds is loaded, so it lives at the very top of the file.
process.env.cds_remote_native__fetch = 'true'

const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-attributes')
const http = require('http')

// Native fetch path: when cds.env.remote.native_fetch === true (or no cloud sdk is
// installed), CAP routes outbound remote calls through native fetch, which is
// instrumented by @opentelemetry/instrumentation-undici. The outbound span therefore
// comes from that instrumentation scope (NOT @opentelemetry/instrumentation-http, and
// NOT our cloud_sdk wrapper) and carries the standard http.* / url.* / server.* attributes.
describe('tracing remote via native fetch', () => {
  const log = vi.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  const getSpans = () => log.mock.calls.map(c => c[0]).filter(Boolean)

  let server, port

  beforeAll(
    () =>
      new Promise(resolve => {
        server = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ value: [] }))
        })
        server.listen(0, () => {
          port = server.address().port
          resolve()
        })
      })
  )

  afterAll(() => new Promise(resolve => server.close(resolve)))

  test('outbound call is traced by @opentelemetry/instrumentation-undici', async () => {
    expect(cds.env.remote?.native_fetch).to.equal(true)

    cds.env.requires.TestRemote = { kind: 'odata', credentials: { url: `http://localhost:${port}` } }
    const remote = await cds.connect.to('TestRemote')

    // no mock handler - let it make the actual HTTP call via native fetch
    await remote.send({ method: 'GET', path: '/test' })

    const undiciSpan = getSpans().find(s => s.instrumentationScope?.name === '@opentelemetry/instrumentation-undici')
    expect(undiciSpan, 'no span from @opentelemetry/instrumentation-undici').to.exist
    expect(undiciSpan.attributes['http.request.method']).to.equal('GET')
    expect(undiciSpan.attributes['http.response.status_code']).to.equal(200)
    expect(undiciSpan.attributes['url.full']).to.equal(`http://localhost:${port}/test`)
    expect(undiciSpan.attributes['server.address']).to.equal('localhost')
    expect(undiciSpan.attributes['server.port']).to.equal(port)
  })
})
