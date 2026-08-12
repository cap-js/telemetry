const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-attributes')
const http = require('http')

// Cloud SDK path: with @sap-cloud-sdk/http-client installed (as in the bookshop) and
// cds.env.remote.native_fetch NOT set, CAP routes outbound remote calls through
// getCloudSdk().executeHttpRequestWithOrigin(...). lib/tracing/cloud_sdk.js wraps that
// export so the outbound call produces a @cap-js/telemetry CLIENT span carrying
// the sap.btp.destination attribute.
describe('tracing remote via cloud sdk', () => {
  const log = vi.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  const getSpans = () => log.mock.calls.map(c => c[0]).filter(Boolean)
  const getCapSpans = () => getSpans().filter(s => s.instrumentationScope?.name === '@cap-js/telemetry')

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

  test('outbound call is traced by the cloud_sdk wrapper with sap.btp.destination', async () => {
    // a named destination object -> destination.name flows into the CLIENT span attribute
    cds.env.requires.TestRemote = {
      kind: 'odata',
      credentials: { destination: { name: 'my-destination', url: `http://localhost:${port}` } }
    }
    const remote = await cds.connect.to('TestRemote')

    // no mock handler - let it make the actual HTTP call via the cloud sdk
    await remote.send({ method: 'GET', path: '/test' })

    // the cloud sdk path must not go through native fetch / undici
    expect(cds.env.remote?.native_fetch).not.to.equal(true)

    // the outbound span comes from our tracer (not from undici) ...
    const clientSpan = getCapSpans().find(s => s.attributes?.['code.function.name'] === 'executeHttpRequestWithOrigin')
    expect(clientSpan, 'cloud_sdk wrapper did not produce a CLIENT span').to.exist
    // ... is a CLIENT span (kind 2) ...
    expect(clientSpan.kind).to.equal(2)
    // ... and carries the destination name
    expect(clientSpan.attributes['sap.btp.destination']).to.equal('my-destination')

    // no undici span for this call (cloud sdk path is used, not native fetch)
    const undiciSpans = getSpans().filter(s => s.instrumentationScope?.name === '@opentelemetry/instrumentation-undici')
    expect(undiciSpans.length).to.equal(0)
  })
})
