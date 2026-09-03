const cds = require('@sap/cds')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { trace } = require('@opentelemetry/api')

// Mock VCAP_SERVICES for CaaS
const MOCK_CAAS_VCAP = {
  'caas-service': [{
    name: 'test-caas',
    credentials: {
      otlp: {
        http: 'https://caas.example.com/otlp',
        grpc: 'grpc://caas.example.com:4317'
      }
    }
  }]
}

// Mock VCAP_SERVICES with ZTI binding
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

// Test certificates
const CERT_V1 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_1\n-----END CERTIFICATE-----'
const KEY_V1 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_1\n-----END PRIVATE KEY-----'
const BUNDLE_V1 = '-----BEGIN CERTIFICATE-----\nBUNDLE_V1\n-----END CERTIFICATE-----'
const CERT_V2 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_2\n-----END CERTIFICATE-----'
const KEY_V2 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_2\n-----END PRIVATE KEY-----'
const BUNDLE_V2 = '-----BEGIN CERTIFICATE-----\nBUNDLE_V2\n-----END CERTIFICATE-----'

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
      delete require.cache[require.resolve('../lib/utils')]
      delete require.cache[require.resolve('../lib/zti')]
    },
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.VCAP_SERVICES
      delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
      delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
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
    cds.env.requires = cds.env.requires || {}
    cds.env.requires.telemetry = {
      x509: {
        cert: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----').toString('base64'),
        key: Buffer.from('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----').toString('base64')
      }
    }
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
  })

  test('sets baseUrl from otlp.http', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: {
        http: 'https://caas.example.com/otlp',
        grpc: 'grpc://caas.example.com:4317'
      }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.baseUrl).toBe('https://caas.example.com/otlp')
  })

  test('sets httpAgentOptions when mTLS credentials found', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeDefined()
    expect(typeof credentials.httpAgentOptions).toBe('function')
  })

  test('throws when no OTLP endpoints', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    const { augmentCaaSCreds } = require('../lib/utils')

    expect(() => augmentCaaSCreds({})).toThrow('No OTLP HTTP endpoint in CaaS credentials')
  })

  test('does not augment twice', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)
    const originalBaseUrl = credentials.baseUrl

    credentials.otlp.http = 'https://different.com'
    augmentCaaSCreds(credentials)

    expect(credentials.baseUrl).toBe(originalBaseUrl)
  })

  test('no httpAgentOptions when mTLS credentials not found', () => {
    cds.env.requires.telemetry = {} // No x509 credentials
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeUndefined()
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
    test('detects ZTI config from VCAP_SERVICES', () => {
      jest.isolateModules(() => {
        const { getZTIConfig } = require('../lib/zti')
        const config = getZTIConfig()

        expect(config).not.toBeNull()
        expect(config.svidName).toBe('test-svid')
        expect(config.svidDir).toBe(ctx.svidDir)
      })
    })

    test('returns null when no ZTI binding', () => {
      process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)

      jest.isolateModules(() => {
        const { getZTIConfig } = require('../lib/zti')
        expect(getZTIConfig()).toBeNull()
      })
    })
  })

  describe('createZTIAgentFactory', () => {
    test('returns factory when SVID files exist', () => {
      ctx.writeSVIDFiles()

      jest.isolateModules(() => {
        const { createZTIAgentFactory } = require('../lib/utils')
        const factory = createZTIAgentFactory()

        expect(factory).not.toBeNull()
        expect(typeof factory).toBe('function')

        const agent = factory()
        expect(agent.options.keepAlive).toBe(true)
        expect(agent.options.cert).toBe(CERT_V1)
        expect(agent.options.key).toBe(KEY_V1)

        require('../lib/zti').reset()
      })
    })

    test('factory throws when SVID files do not exist', () => {
      jest.isolateModules(() => {
        const { createZTIAgentFactory } = require('../lib/utils')
        const factory = createZTIAgentFactory()

        expect(factory).not.toBeNull()
        expect(() => factory()).toThrow()
      })
    })
  })

  // Certificate rotation works for both interval-based exports (production, metrics) and
  // on-demand exports (tracing/logging in development). The test verifies this by checking
  // that the factory returns a singleton: after _rotate() updates the agent's certs,
  // any subsequent factory() call - whether from a scheduled interval or an immediate
  // span.end() - returns the same agent instance with the rotated certificates.
  describe('certificate rotation', () => {
    test('agent reloads certificate when mtime changes', () => {
      ctx.writeSVIDFiles()

      jest.isolateModules(() => {
        const { createZTIAgentFactory } = require('../lib/utils')
        const { reset } = require('../lib/zti')

        const factory = createZTIAgentFactory()
        const agent = factory()
        expect(agent.options.cert).toBe(CERT_V1)
        expect(agent.options.key).toBe(KEY_V1)

        // Simulate certificate rotation
        ctx.writeSVIDFiles(CERT_V2, KEY_V2, BUNDLE_V2)
        ctx.touchCertFile()
        agent._rotate()

        expect(agent.options.cert).toBe(CERT_V2)
        expect(agent.options.key).toBe(KEY_V2)

        // Factory returns same singleton — on-demand exports use rotated certs
        expect(factory()).toBe(agent)

        reset()
      })
    })

    test('agent serves cached cert during transient read failure', () => {
      ctx.writeSVIDFiles()

      jest.isolateModules(() => {
        const { createZTIAgentFactory } = require('../lib/utils')
        const { reset } = require('../lib/zti')

        const factory = createZTIAgentFactory()
        const agent = factory()
        expect(agent.options.cert).toBe(CERT_V1)

        // Simulate mid-rotation: touch mtime but make key file unreadable
        ctx.touchCertFile()
        fs.unlinkSync(path.join(ctx.svidDir, 'test-svid.svid.key'))

        // _rotate should fail but agent should keep old certs
        agent._rotate()
        expect(agent.options.cert).toBe(CERT_V1)

        // Factory returns same singleton — on-demand exports still work with cached certs
        expect(factory()).toBe(agent)

        reset()
      })
    })
  })

  describe('x509 fallback', () => {
    test('createStaticAgentFactory returns factory when x509 configured', () => {
      process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
      cds.env.requires.telemetry.x509 = {
        cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar\n-----END CERTIFICATE-----').toString('base64'),
        key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar\n-----END PRIVATE KEY-----').toString('base64')
      }

      ctx.clearModuleCache()
      const { createStaticAgentFactory } = require('../lib/utils')
      const factory = createStaticAgentFactory()

      expect(factory).toBeDefined()
      expect(typeof factory).toBe('function')
    })

    test('augmentCaaSCreds uses ZTI agent factory', () => {
      ctx.writeSVIDFiles()

      jest.isolateModules(() => {
        const { augmentCaaSCreds } = require('../lib/utils')
        const { reset } = require('../lib/zti')

        const credentials = { otlp: { http: 'https://caas.example.com/otlp' } }
        augmentCaaSCreds(credentials)

        expect(credentials.httpAgentOptions).toBeDefined()
        expect(typeof credentials.httpAgentOptions).toBe('function')

        reset()
      })
    })

    test('augmentCaaSCreds uses x509 agent factory when ZTI disabled', () => {
      process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
      process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
      cds.env.requires.telemetry.x509 = {
        cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar-cert\n-----END CERTIFICATE-----').toString('base64'),
        key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar-key\n-----END PRIVATE KEY-----').toString('base64')
      }

      ctx.clearModuleCache()
      const { augmentCaaSCreds } = require('../lib/utils')

      const credentials = { otlp: { http: 'https://caas.example.com/otlp' } }
      augmentCaaSCreds(credentials)

      expect(credentials.httpAgentOptions).toBeDefined()
      expect(typeof credentials.httpAgentOptions).toBe('function')
    })
  })
})

describe('LazyExporter', () => {
  test('buffers items until exporter is ready', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let ready = false
    const mockExporter = {
      export: jest.fn((items, cb) => cb({ code: 0 })),
      shutdown: jest.fn(() => Promise.resolve()),
      forceFlush: jest.fn(() => Promise.resolve())
    }

    const lazy = createLazyExporter(() => {
      if (!ready) return { status: 'not_ready' }
      return { status: 'ok', exporter: mockExporter }
    })

    // Export while not ready - should buffer
    lazy.export(['item1'], () => {})
    lazy.export(['item2'], () => {})
    expect(mockExporter.export).not.toHaveBeenCalled()

    // Now make exporter ready
    ready = true

    // Next export triggers flush + new export
    lazy.export(['item3'], () => {})
    expect(mockExporter.export).toHaveBeenCalledTimes(3) // 2 buffered + 1 new
  })

  test('drops oldest when buffer full', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let ready = false
    const exportedItems = []
    const mockExporter = {
      export: jest.fn((items, cb) => {
        exportedItems.push(...items)
        cb({ code: 0 })
      })
    }

    const lazy = createLazyExporter(() => {
      if (!ready) return { status: 'not_ready' }
      return { status: 'ok', exporter: mockExporter }
    })

    // Fill buffer beyond max (1000)
    for (let i = 0; i < 1005; i++) {
      lazy.export([`item${i}`], () => {})
    }

    // Make exporter ready and trigger flush
    ready = true
    lazy.export(['final'], () => {})

    // Buffer was capped at 1000, so oldest 5 items were dropped
    // Exported: 1000 buffered + 1 final = 1001
    expect(exportedItems.length).toBe(1001)
    expect(exportedItems[0]).toBe('item5') // item0-4 were dropped
    expect(exportedItems[999]).toBe('item1004')
    expect(exportedItems[1000]).toBe('final')
  })

  test('handles permanent failure', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    const lazy = createLazyExporter(() => ({
      status: 'error',
      error: new Error('Config error')
    }))

    const callback = jest.fn()
    lazy.export(['item1'], callback)

    // Should report error
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }))
  })

  test('proxies selectAggregationTemporality to real exporter when ready', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')
    const { InstrumentType } = require('@opentelemetry/sdk-metrics')

    let ready = false
    const mockSelectAggregationTemporality = jest.fn(instrumentType => {
      // Mock returns unique values we can verify
      if (instrumentType === InstrumentType.COUNTER) return 99
      if (instrumentType === InstrumentType.UP_DOWN_COUNTER) return 88
      return 77
    })

    const mockExporter = {
      export: jest.fn((_, cb) => cb({ code: 0 })),
      shutdown: jest.fn(() => Promise.resolve()),
      forceFlush: jest.fn(() => Promise.resolve()),
      selectAggregationTemporality: mockSelectAggregationTemporality
    }

    const lazy = createLazyExporter(() => {
      if (!ready) return { status: 'not_ready' }
      return { status: 'ok', exporter: mockExporter }
    })

    // Before ready: uses fallback, doesn't call mock
    lazy.export(['item1'], () => {})
    const beforeReady = lazy.selectAggregationTemporality(InstrumentType.COUNTER)
    expect(beforeReady).toBe(0) // Fallback returns DELTA
    expect(mockSelectAggregationTemporality).not.toHaveBeenCalled()

    // Trigger exporter creation
    ready = true
    lazy.export(['item2'], () => {})

    // After exporter ready: should proxy to mock and return its values
    const counterResult = lazy.selectAggregationTemporality(InstrumentType.COUNTER)
    expect(mockSelectAggregationTemporality).toHaveBeenCalledWith(InstrumentType.COUNTER)
    expect(counterResult).toBe(99) // Mock's return value, not our fallback

    const upDownResult = lazy.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER)
    expect(mockSelectAggregationTemporality).toHaveBeenCalledWith(InstrumentType.UP_DOWN_COUNTER)
    expect(upDownResult).toBe(88) // Mock's return value, not our fallback

    // Verify it truly delegates, not using our logic
    expect(mockSelectAggregationTemporality).toHaveBeenCalledTimes(2)
  })

  test('returns correct temporality fallback when exporter not ready', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')
    const { InstrumentType, AggregationTemporality } = require('@opentelemetry/sdk-metrics')

    // Exporter never becomes ready
    const lazy = createLazyExporter(() => ({ status: 'not_ready' }))

    // COUNTER and HISTOGRAM should get DELTA (0)
    expect(lazy.selectAggregationTemporality(InstrumentType.COUNTER))
      .toBe(AggregationTemporality.DELTA)
    expect(lazy.selectAggregationTemporality(InstrumentType.HISTOGRAM))
      .toBe(AggregationTemporality.DELTA)

    // UP_DOWN_COUNTER should get CUMULATIVE (1)
    expect(lazy.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER))
      .toBe(AggregationTemporality.CUMULATIVE)
    expect(lazy.selectAggregationTemporality(InstrumentType.OBSERVABLE_UP_DOWN_COUNTER))
      .toBe(AggregationTemporality.CUMULATIVE)
  })
})

describe('Logging exporter error handling', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../lib/logging')]
    delete require.cache[require.resolve('../lib/utils')]
  })

  test('gracefully handles missing logs exporter module (MODULE_NOT_FOUND)', () => {
    const logInfoSpy = jest.fn()

    // Mock cds.log before requiring the logging module
    jest.isolateModules(() => {
      const cds = require('@sap/cds')
      const originalLog = cds.log
      cds.log = (name) => {
        if (name === 'telemetry') {
          return { _info: true, info: logInfoSpy, _debug: false, _warn: false }
        }
        return originalLog(name)
      }

      cds.env.requires = {
        telemetry: {
          kind: 'telemetry-to-caas',
          logging: {
            exporter: {
              module: '@opentelemetry/non-existent-module-12345',
              class: 'OTLPLogExporter'
            }
          }
        }
      }

      const loggingSetup = require('../lib/logging')
      const result = loggingSetup({})

      // Should return null and not throw
      expect(result).toBeNull()

      // Should log helpful message
      expect(logInfoSpy).toHaveBeenCalled()
      const logMessage = logInfoSpy.mock.calls[0][0]
      expect(logMessage).toContain('not found')
      expect(logMessage).toContain('@opentelemetry/non-existent-module-12345')

      cds.log = originalLog
    })
  })

  test('throws when exporter class not found in module', () => {
    jest.isolateModules(() => {
      const cds = require('@sap/cds')
      cds.env.requires = {
        telemetry: {
          kind: 'telemetry-to-caas',
          logging: {
            exporter: {
              module: '@opentelemetry/sdk-logs',
              class: 'NonExistentExporter'
            }
          }
        }
      }

      const loggingSetup = require('../lib/logging')

      expect(() => loggingSetup({})).toThrow('Unknown logs exporter "NonExistentExporter"')
    })
  })
})

describe('CaaS integration', () => {
  let ctx

  beforeEach(() => {
    ctx = createZTITestContext()
    ctx.setupEnv()
    process.env.cds_requires_telemetry_kind = 'to-caas'

    // Clear all relevant module caches
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
    delete require.cache[require.resolve('../lib/index')]
    delete require.cache[require.resolve('../lib/tracing')]
    delete require.cache[require.resolve('../lib/metrics')]
    delete require.cache[require.resolve('../lib/logging')]
  })

  afterEach(() => {
    ctx.cleanup()
    delete process.env.cds_requires_telemetry_kind
    delete process.env.cds_requires_telemetry_tracing_exporter
  })

  test('TracerProvider works with ZTI credentials', () => {
    ctx.writeSVIDFiles()

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
        credentials: {
          otlp: { http: 'https://caas.example.com/otlp' }
        },
        tracing: {
          exporter: {
            module: '@opentelemetry/sdk-trace-base',
            class: 'InMemorySpanExporter'
          },
          sampler: { kind: 'AlwaysOnSampler' },
          propagators: []
        },
        instrumentations: {}
      }
    }

    const setup = require('../lib/index')
    setup()

    // Verify tracer works (not a NoopTracer)
    const tracer = trace.getTracer('test')
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000')
    span.end()
  })

  test('Metrics use DELTA aggregation temporality with ZTI', () => {
    ctx.writeSVIDFiles()

    cds.env.requires = {
      telemetry: {
        kind: 'to-caas',
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

    const { AggregationTemporality, InstrumentType } = require('@opentelemetry/sdk-metrics')
    const { getResource } = require('../lib/utils')
    const metricsSetup = require('../lib/metrics')

    // Setup metrics with resource
    const resource = getResource()
    const meterProvider = metricsSetup(resource)

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
