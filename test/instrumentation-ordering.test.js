// Regression guard for the instrumentation-vs-tracing setup ordering (lib/index.js
// setup_standalone). The instrumentations must be CONSTRUCTED before tracing() runs.
//
// Why it matters: tracing() loads the SAP Cloud SDK (-> axios -> follow-redirects), which is
// what CAP uses for outbound remote calls by default. axios/follow-redirects reach Node's
// `https` through @opentelemetry/instrumentation-http's patched functions only if that
// instrumentation is already in place when the Cloud SDK is first required. On the broken
// ordering the Cloud SDK is loaded first, so its outbound `https` requests bypass
// instrumentation-http entirely and the actual network call goes untraced (only our own
// cloud_sdk wrapper span survives). `http` is unaffected in practice because the running
// server re-requires it after the hook exists; `https` is the one that slips through.
//
// The probe is a single outbound HTTPS request through a configured destination (see the
// [instrumentation-ordering] profile). We only need the request to be ISSUED, not to succeed:
// instrumentation-http opens the CLIENT span when https.request is called, so a dead endpoint
// still yields the span on the correct ordering and still yields none on the broken ordering.
// That lets the test skip a live TLS server and self-signed cert altogether.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory,instrumentation-ordering')
const { SpanKind } = require('@opentelemetry/api')

const { captured, reset } = require('./bookshop/lib/MyInMemorySpanExporter')

describe('instrumentation ordering: outbound https is traced by instrumentation-http', () => {
  beforeEach(reset)

  // Guard the premise: the ordering bug is only exposed because tracing() pulls the Cloud SDK
  // (and thus https) early. If the cloud sdk ever stops resolving here, fail loudly instead of
  // passing vacuously.
  test('@sap-cloud-sdk/http-client resolves (precondition)', () => {
    expect(() => require.resolve('@sap-cloud-sdk/http-client')).not.to.throw()
  })

  test('outbound https sub-request produces an @opentelemetry/instrumentation-http CLIENT span', async () => {
    const remote = await cds.connect.to('TestRemote')
    // The destination points at a dead port: the request is refused, but the CLIENT span is
    // opened when https.request is issued, which is all this asserts. Swallow the connect error.
    await remote.send({ method: 'GET', path: '/test' }).catch(() => {})

    // The actual outbound https call must be traced by instrumentation-http. On the broken
    // ordering https is never routed through the patched functions, so no such span exists.
    const httpClientSpan = captured.find(
      s => s.instrumentationScope?.name === '@opentelemetry/instrumentation-http' && s.kind === SpanKind.CLIENT
    )
    expect(httpClientSpan, 'no CLIENT span from @opentelemetry/instrumentation-http for the outbound https call').to
      .exist
  })
})
