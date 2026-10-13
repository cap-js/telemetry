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
// So we boot the plugin on the Cloud SDK path (tracing-in-memory profile, cloud sdk installed),
// make a real outbound HTTPS call through a destination, and assert that it produced a CLIENT
// span from @opentelemetry/instrumentation-http. On the broken ordering that span is absent.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { SpanKind } = require('@opentelemetry/api')

const { captured, reset } = require('./bookshop/lib/MyInMemorySpanExporter')

describe('instrumentation ordering: outbound https is traced by instrumentation-http', () => {
  let server, port, certDir

  beforeAll(() => {
    // Throwaway self-signed localhost cert, generated into a temp dir (never committed - a
    // private key must not live in the repo). openssl is available on the CI runners and locally.
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-https-'))
    const key = path.join(certDir, 'key.pem')
    const cert = path.join(certDir, 'cert.pem')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '1', '-nodes', '-subj', '/CN=localhost'
    ], { stdio: 'ignore' })

    return new Promise(resolve => {
      server = https.createServer(
        { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
        (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ value: [] }))
        }
      )
      server.listen(0, () => {
        port = server.address().port
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(certDir, { recursive: true, force: true })
  })

  beforeEach(reset)

  // Guard the premise: the ordering bug is only exposed because tracing() pulls the Cloud SDK
  // (and thus https) early. If the cloud sdk ever stops resolving here, fail loudly instead of
  // passing vacuously.
  test('@sap-cloud-sdk/http-client resolves (precondition)', () => {
    expect(() => require.resolve('@sap-cloud-sdk/http-client')).not.to.throw()
  })

  test('outbound https sub-request produces an @opentelemetry/instrumentation-http CLIENT span', async () => {
    // isTrustingAllCertificates: the Cloud SDK otherwise rejects the self-signed cert.
    cds.env.requires.TestRemote = {
      kind: 'odata',
      credentials: {
        destination: { name: 'my-destination', url: `https://localhost:${port}`, isTrustingAllCertificates: true }
      }
    }
    const remote = await cds.connect.to('TestRemote')
    await remote.send({ method: 'GET', path: '/test' })

    // The actual outbound https call must be traced by instrumentation-http. On the broken
    // ordering https is never routed through the patched functions, so no such span exists.
    const httpClientSpan = captured.find(
      s => s.instrumentationScope?.name === '@opentelemetry/instrumentation-http' && s.kind === SpanKind.CLIENT
    )
    expect(httpClientSpan, 'no CLIENT span from @opentelemetry/instrumentation-http for the outbound https call').to
      .exist
  })
})
