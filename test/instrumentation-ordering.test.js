// Regression guard for lib/index.js setup_standalone: the instrumentations must be CONSTRUCTED
// before tracing() runs. tracing() loads the SAP Cloud SDK (-> axios -> follow-redirects); unless
// @opentelemetry/instrumentation-http's require hook is already in place, the SDK's outbound `https`
// bypasses it and the call goes untraced (only our own cloud_sdk wrapper span survives). `http` is
// unaffected (the server re-requires it after the hook exists); `https` is the one that slips through.
// So: boot the plugin on the Cloud SDK path and assert a real outbound HTTPS call produces a CLIENT
// span from @opentelemetry/instrumentation-http — absent on the broken ordering.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { SpanKind } = require('@opentelemetry/api')

const { captured, reset } = require('./bookshop/lib/MyInMemorySpanExporter')

// We mint a throwaway self-signed cert via the openssl binary (below). Probe for it once so an
// environment without openssl on PATH skips cleanly instead of erroring the whole file in beforeAll.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('instrumentation ordering: outbound https is traced by instrumentation-http', () => {
  if (!hasOpenssl) {
    test.skip('needs the openssl binary to generate a throwaway TLS cert', () => {})
    return
  }

  let server, port, certDir

  beforeAll(() => {
    // Throwaway self-signed localhost cert, generated into a temp dir (never committed - a
    // private key must not live in the repo).
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-https-'))
    const key = path.join(certDir, 'key.pem')
    const cert = path.join(certDir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost'
      ],
      { stdio: 'ignore' }
    )

    return new Promise(resolve => {
      server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ value: [] }))
      })
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

    // The outbound https call itself must be traced; on the broken ordering no such span exists.
    const httpClientSpan = captured.find(
      s => s.instrumentationScope?.name === '@opentelemetry/instrumentation-http' && s.kind === SpanKind.CLIENT
    )
    expect(httpClientSpan, 'no CLIENT span from @opentelemetry/instrumentation-http for the outbound https call').to
      .exist
  })
})
