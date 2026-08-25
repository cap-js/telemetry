/**
 * Integration tests for ZTI + Tracing with LazyExporter
 *
 * With the lazy exporter refactor, the complexity of waiting for ZTI credentials
 * is moved into the exporter layer. The app starts immediately with sync initialization,
 * and telemetry is buffered until SVID files become available.
 */

const cds = require('@sap/cds')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { trace } = require('@opentelemetry/api')

// Mock VCAP_SERVICES with ZTI and CaaS
const MOCK_ZTI_VCAP = {
  'caas-service': [{
    name: 'test-caas',
    credentials: {
      otlp: {
        http: 'https://caas.example.com/otlp'
      }
    }
  }],
  'zero-trust-identity': [{
    name: 'test-zti',
    credentials: {
      parameters: {
        'svid-store': {
          file: { name: 'test-svid' }
        }
      }
    }
  }]
}

describe('Tracing with ZTI integration', () => {
  let tmpDir
  let svidDir
  let originalEnv

  beforeAll(() => {
    // Save original environment
    originalEnv = {
      VCAP_SERVICES: process.env.VCAP_SERVICES,
      CDS_REQUIRES_TELEMETRY_ZTI_DIR: process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR,
      CDS_REQUIRES_TELEMETRY_USE_ZTI: process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI,
      cds_requires_telemetry_kind: process.env.cds_requires_telemetry_kind,
      cds_requires_telemetry_tracing_exporter: process.env.cds_requires_telemetry_tracing_exporter
    }
  })

  afterAll(() => {
    // Restore original environment
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  })

  beforeEach(() => {
    // Create temp directory for SVID files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zti-tracing-test-'))
    svidDir = path.join(tmpDir, 'spire-svids')
    fs.mkdirSync(svidDir)

    // Setup ZTI environment
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR = svidDir
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
    process.env.cds_requires_telemetry_kind = 'to-caas'

    // Clear module cache
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    delete require.cache[require.resolve('../lib/index')]
    delete require.cache[require.resolve('../lib/tracing')]
    delete require.cache[require.resolve('../lib/metrics')]
    delete require.cache[require.resolve('../lib/logging')]
    delete require.cache[require.resolve('../lib/exporter/LazyExporter')]
  })

  afterEach(() => {
    // Cleanup
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    delete process.env.VCAP_SERVICES
    delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
    delete process.env.cds_requires_telemetry_kind
    delete process.env.cds_requires_telemetry_tracing_exporter
  })

  test('telemetry setup completes synchronously even without SVID files', () => {
    // SVID files don't exist yet - but setup should still complete (sync)

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
        credentials: {
          otlp: {
            http: 'https://caas.example.com/otlp'
          }
        },
        tracing: {
          exporter: {
            module: '@opentelemetry/sdk-trace-base',
            class: 'InMemorySpanExporter'
          },
          sampler: {
            kind: 'AlwaysOnSampler'
          },
          propagators: []
        },
        instrumentations: {}
      }
    }

    // Setup should be sync and not throw
    const setup = require('../lib/index')
    expect(() => setup()).not.toThrow()

    // We should have a real tracer (not NoopTracer)
    const tracer = trace.getTracer('test')
    expect(tracer).toBeDefined()

    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000')
    span.end()
  })

  test('TracerProvider is registered immediately (no NoopTracer caching)', () => {
    // Create SVID files
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
        credentials: {
          otlp: {
            http: 'https://caas.example.com/otlp'
          }
        },
        tracing: {
          exporter: {
            module: '@opentelemetry/sdk-trace-base',
            class: 'InMemorySpanExporter'
          },
          sampler: {
            kind: 'AlwaysOnSampler'
          },
          propagators: []
        },
        instrumentations: {}
      }
    }

    // Setup telemetry
    const setup = require('../lib/index')
    setup()

    // Verify we can get a tracer (not NoopTracer)
    const tracer = trace.getTracer('test')
    expect(tracer).toBeDefined()

    // Create a span and verify it's a real span (NoopTracer returns zeros for traceId)
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000')
    span.end()
  })

  test('standard flow works without ZTI binding', () => {
    // Remove ZTI from VCAP_SERVICES
    process.env.VCAP_SERVICES = JSON.stringify({
      'caas-service': [{
        name: 'test-caas',
        credentials: {
          otlp: {
            http: 'https://caas.example.com/otlp'
          }
        }
      }]
    })

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
        credentials: {
          otlp: {
            http: 'https://caas.example.com/otlp'
          }
        },
        x509: {
          cert: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----').toString('base64'),
          key: Buffer.from('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----').toString('base64')
        },
        tracing: {
          exporter: {
            module: '@opentelemetry/sdk-trace-base',
            class: 'InMemorySpanExporter'
          },
          sampler: {
            kind: 'AlwaysOnSampler'
          },
          propagators: []
        },
        instrumentations: {}
      }
    }

    delete require.cache[require.resolve('../lib/zti')]

    // Standard setup should work
    const setup = require('../lib/index')
    setup()

    const tracer = trace.getTracer('test')
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    span.end()
  })

  test('getCredsForCaaSMtls returns null when SVID files not ready', () => {
    // Don't create SVID files

    jest.isolateModules(() => {
      const { getCredsForCaaSMtls } = require('../lib/zti')
      const creds = getCredsForCaaSMtls()

      // Should return null (not throw) when files don't exist
      expect(creds).toBeNull()
    })
  })

  test('getCredsForCaaSMtls returns credentials when SVID files exist', () => {
    // Create SVID files
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    jest.isolateModules(() => {
      const { getCredsForCaaSMtls } = require('../lib/zti')
      const creds = getCredsForCaaSMtls()

      expect(creds).toBeDefined()
      expect(creds.cert).toContain('BEGIN CERTIFICATE')
      expect(creds.key).toContain('BEGIN PRIVATE KEY')
    })
  })

  test('legacy x509 credentials work when USE_ZTI=false', () => {
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'

    // Need to set up cds.env inside isolateModules since cds is re-required there
    delete require.cache[require.resolve('../lib/zti')]

    cds.env.requires = {
      telemetry: {
        x509: {
          cert: Buffer.from('-----BEGIN CERTIFICATE-----\nlegacy\n-----END CERTIFICATE-----').toString('base64'),
          key: Buffer.from('-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----').toString('base64')
        }
      }
    }

    const { getCredsForCaaSMtls } = require('../lib/zti')
    const creds = getCredsForCaaSMtls()

    expect(creds).toBeDefined()
    expect(Buffer.from(creds.cert, 'base64').toString()).toContain('legacy')
  })
})
