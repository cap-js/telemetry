const cds = require('@sap/cds')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { trace } = require('@opentelemetry/api')

// Mock VCAP_SERVICES for CaaS
const MOCK_CAAS_VCAP = {
  'caas-service': [
    {
      name: 'test-caas',
      credentials: {
        otlp: {
          http: 'https://caas.example.com/otlp',
          grpc: 'grpc://caas.example.com:4317'
        }
      }
    }
  ]
}

// Mock VCAP_SERVICES with ZTI binding
const MOCK_ZTI_VCAP = {
  'caas-service': [
    {
      name: 'test-caas',
      credentials: {
        otlp: {
          http: 'https://caas.example.com/otlp'
        }
      }
    }
  ],
  'zero-trust-identity': [
    {
      name: 'test-zti',
      credentials: {
        parameters: {
          'svid-store': {
            file: { name: 'test-svid' }
          }
        }
      }
    }
  ]
}

// Test certificates
const CERT_V1 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_1\n-----END CERTIFICATE-----'
const KEY_V1 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_1\n-----END PRIVATE KEY-----'
const BUNDLE_V1 = '-----BEGIN CERTIFICATE-----\nBUNDLE_V1\n-----END CERTIFICATE-----'
const CERT_V2 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_2\n-----END CERTIFICATE-----'
const KEY_V2 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_2\n-----END PRIVATE KEY-----'

// Shared test helper for ZTI setup
function createZTITestContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zti-test-'))
  const svidDir = path.join(tmpDir, 'spire-svids')
  fs.mkdirSync(svidDir)

  return {
    tmpDir,
    svidDir,
    writeSVIDFiles(cert = CERT_V1, key = KEY_V1, bundle = BUNDLE_V1) {
      fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), cert)
      fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), key)
      fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), bundle)
    },
    touchCertFile() {
      const now = new Date()
      now.setSeconds(now.getSeconds() + 2)
      fs.utimesSync(path.join(svidDir, 'test-svid.svid.pem'), now, now)
    },
    setupEnv() {
      process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
      process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR = svidDir
      delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
      cds.env.requires = { telemetry: {} }
    },
    clearModuleCache() {
      vi.resetModules()
    },
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.VCAP_SERVICES
      delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
      delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
      vi.resetModules()
    }
  }
}

describe('augmentCaaSCreds', () => {
  let originalVcap

  beforeAll(() => {
    originalVcap = process.env.VCAP_SERVICES
  })

  afterAll(() => {
    if (originalVcap) process.env.VCAP_SERVICES = originalVcap
    else delete process.env.VCAP_SERVICES
  })

  beforeEach(() => {
    vi.resetModules()
    cds.env.requires = cds.env.requires || {}
    cds.env.requires.telemetry = {
      x509: {
        cert: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----').toString('base64'),
        key: Buffer.from('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----').toString('base64')
      }
    }
  })

  test('sets baseUrl from otlp.http', async () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    const { augmentCaaSCreds } = await import('../lib/utils.js')

    const credentials = {
      otlp: {
        http: 'https://caas.example.com/otlp',
        grpc: 'grpc://caas.example.com:4317'
      }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.baseUrl).toBe('https://caas.example.com/otlp')
  })

  test('sets httpAgentOptions when mTLS credentials found', async () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    const { augmentCaaSCreds } = await import('../lib/utils.js')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeDefined()
    expect(typeof credentials.httpAgentOptions).toBe('function')
  })

  test('throws when no OTLP endpoints', async () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    const { augmentCaaSCreds } = await import('../lib/utils.js')

    expect(() => augmentCaaSCreds({})).toThrow('No OTLP HTTP endpoint in CaaS credentials')
  })

  test('does not augment twice', async () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    const { augmentCaaSCreds } = await import('../lib/utils.js')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)
    const originalBaseUrl = credentials.baseUrl

    credentials.otlp.http = 'https://different.com'
    augmentCaaSCreds(credentials)

    expect(credentials.baseUrl).toBe(originalBaseUrl)
  })

  test('httpAgentOptions always set (agent works once certs available)', async () => {
    cds.env.requires.telemetry = {} // No x509 credentials
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    const { augmentCaaSCreds } = await import('../lib/utils.js')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    // Agent factory is always set — agent works once certs become available
    expect(credentials.httpAgentOptions).toBeDefined()
    expect(typeof credentials.httpAgentOptions).toBe('function')
  })
})

describe('ZTI', () => {
  let ctx

  beforeEach(() => {
    ctx = createZTITestContext()
    ctx.setupEnv()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  describe('getZTIConfig', () => {
    test('detects ZTI config from VCAP_SERVICES', async () => {
      const { getZTIConfig } = await import('../lib/zti.js')
      const config = getZTIConfig()

      expect(config).not.toBeNull()
      expect(config.svidName).toBe('test-svid')
      expect(config.svidDir).toBe(ctx.svidDir)
    })

    test('returns null when no ZTI binding', async () => {
      process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
      vi.resetModules()

      const { getZTIConfig } = await import('../lib/zti.js')
      expect(getZTIConfig()).toBeNull()
    })
  })

  describe('RotatingCertAgent', () => {
    test('can be created without certs', async () => {
      // No certs in cds.env
      cds.env.requires.telemetry = {}

      const { getRotatingCertAgentClass, reset } = await import('../lib/zti.js')

      // Should not throw
      const RotatingCertAgent = getRotatingCertAgentClass()
      const agent = new RotatingCertAgent()
      expect(agent).toBeDefined()
      expect(agent.options.cert).toBeUndefined()
      expect(agent.options.key).toBeUndefined()

      agent._cleanup()
      reset()
    })

    test('uses certs when available at construction', async () => {
      ctx.writeSVIDFiles()

      const { getRotatingCertAgentClass, initializeZTI, loadInitialCerts, reset } = await import('../lib/zti.js')

      initializeZTI()
      loadInitialCerts()

      const RotatingCertAgent = getRotatingCertAgentClass()
      const agent = new RotatingCertAgent()
      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)

      agent._cleanup()
      reset()
    })
  })

  describe('certsAvailable', () => {
    test('returns false when no certs', async () => {
      cds.env.requires.telemetry = {}
      const { certsAvailable } = await import('../lib/zti.js')
      expect(certsAvailable()).toBe(false)
    })

    test('returns true when certs in cds.env', async () => {
      cds.env.requires = {
        telemetry: {
          x509: { cert: CERT_V1, key: KEY_V1 }
        }
      }
      vi.resetModules()
      const { certsAvailable } = await import('../lib/zti.js')
      expect(certsAvailable()).toBe(true)
    })
  })

  // Certificate rotation works for both interval-based exports (production, metrics) and
  // on-demand exports (tracing/logging in development). The test verifies this by checking
  // that the factory returns a singleton: after rotation via 'svid' event updates the agent's certs,
  // any subsequent factory() call - whether from a scheduled interval or an immediate
  // span.end() - returns the same agent instance with the rotated certificates.
  describe('certificate rotation', () => {
    test('agent rotates certificate when svid event is emitted', async () => {
      ctx.writeSVIDFiles()

      const { getRotatingAgentFactory, initializeZTI, loadInitialCerts, reset } = await import('../lib/zti.js')

      initializeZTI()
      loadInitialCerts()

      const factory = getRotatingAgentFactory()
      const agent = factory()
      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)

      // Simulate certificate rotation via event (as SVID watcher does in production)
      cds.emit('svid', { cert: CERT_V2, key: KEY_V2 })

      expect(agent.options.cert).toBe(CERT_V2)
      expect(agent.options.key).toBe(KEY_V2)

      // Factory returns same singleton — on-demand exports use rotated certs
      expect(factory()).toBe(agent)

      reset()
    })

    test('agent rotates by re-reading cds.env when svid event has no payload', async () => {
      ctx.writeSVIDFiles()

      const { getRotatingAgentFactory, initializeZTI, loadInitialCerts, reset } = await import('../lib/zti.js')

      initializeZTI()
      loadInitialCerts()

      const factory = getRotatingAgentFactory()
      const agent = factory()
      expect(agent.options.cert).toBe(CERT_V1)

      // Simulate manual rotation: update cds.env and emit event without payload
      cds.env.requires.telemetry.x509 = { cert: CERT_V2, key: KEY_V2 }
      cds.emit('svid')

      expect(agent.options.cert).toBe(CERT_V2)
      expect(agent.options.key).toBe(KEY_V2)

      reset()
    })

    test('agent keeps cached cert when rotation event has invalid payload', async () => {
      ctx.writeSVIDFiles()

      const { getRotatingAgentFactory, initializeZTI, loadInitialCerts, reset } = await import('../lib/zti.js')

      initializeZTI()
      loadInitialCerts()

      const factory = getRotatingAgentFactory()
      const agent = factory()
      expect(agent.options.cert).toBe(CERT_V1)

      // Emit event with invalid payload — agent should keep old certs
      cds.emit('svid', { cert: null, key: null })
      expect(agent.options.cert).toBe(CERT_V1)

      // Factory returns same singleton — on-demand exports still work with cached certs
      expect(factory()).toBe(agent)

      reset()
    })
  })

  describe('x509 fallback', () => {
    test('augmentCaaSCreds uses ZTI when available', async () => {
      ctx.writeSVIDFiles()

      const { augmentCaaSCreds } = await import('../lib/utils.js')
      const { reset } = await import('../lib/zti.js')

      const credentials = { otlp: { http: 'https://caas.example.com/otlp' } }
      augmentCaaSCreds(credentials)

      expect(credentials.httpAgentOptions).toBeDefined()
      expect(typeof credentials.httpAgentOptions).toBe('function')
      expect(credentials.useZTI).toBe(true)

      reset()
    })

    test('augmentCaaSCreds uses x509 when ZTI disabled', async () => {
      process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
      process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
      cds.env.requires.telemetry.x509 = {
        cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar-cert\n-----END CERTIFICATE-----').toString('base64'),
        key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar-key\n-----END PRIVATE KEY-----').toString('base64')
      }

      ctx.clearModuleCache()
      const { augmentCaaSCreds } = await import('../lib/utils.js')

      const credentials = { otlp: { http: 'https://caas.example.com/otlp' } }
      augmentCaaSCreds(credentials)

      expect(credentials.httpAgentOptions).toBeDefined()
      expect(typeof credentials.httpAgentOptions).toBe('function')
      expect(credentials.useZTI).toBe(false)
    })
  })
})

describe('CaaS integration', () => {
  let ctx

  beforeEach(() => {
    ctx = createZTITestContext()
    ctx.setupEnv()
    process.env.cds_requires_telemetry_kind = 'to-caas'
    vi.resetModules()
  })

  afterEach(() => {
    ctx.cleanup()
    delete process.env.cds_requires_telemetry_kind
    delete process.env.cds_requires_telemetry_tracing_exporter
  })

  test('TracerProvider works with ZTI credentials', async () => {
    ctx.writeSVIDFiles()

    cds.env.requires = {
      telemetry: {
        kind: 'telemetry-to-caas',
        credentials: {
          otlp: { http: 'https://caas.example.com/otlp' }
        },
        tracing: {
          exporter: {
            module: '@opentelemetry/sdk-trace-base',
            class: 'InMemorySpanExporter'
          },
          sampler: { kind: 'AlwaysOnSampler' },
          propagators: [],
          processor: { kind: 'SimpleSpanProcessor' }
        },
        instrumentations: {}
      }
    }

    const setup = await import('../lib/index.js')
    setup.default()

    // Verify tracer works (not a NoopTracer)
    const tracer = trace.getTracer('test')
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000')
    span.end()
  })

  test('Metrics use DELTA aggregation temporality with ZTI', async () => {
    ctx.writeSVIDFiles()

    cds.env.requires = {
      telemetry: {
        kind: 'telemetry-to-caas',
        credentials: {
          otlp: { http: 'https://caas.example.com/otlp' }
        },
        metrics: {
          exporter: {
            module: '@opentelemetry/exporter-metrics-otlp-proto',
            class: 'OTLPMetricExporter'
          }
        },
        instrumentations: {}
      }
    }

    const { AggregationTemporality, InstrumentType } = await import('@opentelemetry/sdk-metrics')
    const { getResource } = await import('../lib/utils.js')
    const metricsSetup = await import('../lib/metrics/index.js')

    // Setup metrics with resource
    const resource = getResource()
    const meterProvider = metricsSetup.default(resource)

    // Verify metrics provider was created
    expect(meterProvider).toBeDefined()

    // Get the metric collectors (contains the reader)
    const collectors = meterProvider._sharedState.metricCollectors
    expect(collectors).toBeDefined()
    expect(collectors.length).toBeGreaterThan(0)

    const collector = collectors[0]
    expect(collector.selectAggregationTemporality).toBeDefined()

    // Verify DELTA temporality is used (not CUMULATIVE) for COUNTER
    const counterTemporality = collector.selectAggregationTemporality(InstrumentType.COUNTER)
    expect(counterTemporality).toBe(AggregationTemporality.DELTA)
    expect(counterTemporality).not.toBe(AggregationTemporality.CUMULATIVE)

    // Verify for HISTOGRAM as well
    const histogramTemporality = collector.selectAggregationTemporality(InstrumentType.HISTOGRAM)
    expect(histogramTemporality).toBe(AggregationTemporality.DELTA)

    // UP_DOWN_COUNTER should be CUMULATIVE by design (this is correct OTel behavior)
    const upDownCounterTemporality = collector.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER)
    expect(upDownCounterTemporality).toBe(AggregationTemporality.CUMULATIVE)
  })
})
