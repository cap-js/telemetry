/**
 * Integration tests for ZTI + Tracing with dynamic certificate rotation
 *
 * With dynamic https.Agent cert/key functions, certificates are loaded on-demand
 * when new TCP connections are established. The mtime-based caching ensures
 * minimal disk reads while supporting automatic certificate rotation.
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

  test('TracerProvider is registered with ZTI credentials', () => {
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

  test('throws when mTLS credentials are missing (no ZTI files, no x509)', () => {
    // Remove ZTI binding from VCAP_SERVICES (so no ZTI agent)
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

    // No x509 credentials either
    cds.env.requires = {
      telemetry: {
        kind: 'telemetry-to-caas',
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

    delete require.cache[require.resolve('../lib/zti')]

    // Setup should throw because mTLS is required but no credentials available
    const setup = require('../lib/index')
    expect(() => setup()).toThrow('CaaS requires mTLS')
  })

  test('standard flow works without ZTI binding using x509 credentials', () => {
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

  test('x509 env var credentials work when USE_ZTI=false', () => {
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'

    delete require.cache[require.resolve('../lib/zti')]
    delete require.cache[require.resolve('../lib/utils')]

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
        credentials: {
          otlp: {
            http: 'https://caas.example.com/otlp'
          }
        },
        x509: {
          cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar\n-----END CERTIFICATE-----').toString('base64'),
          key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar\n-----END PRIVATE KEY-----').toString('base64')
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

    const setup = require('../lib/index')
    setup()

    const tracer = trace.getTracer('test')
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    span.end()
  })
})
