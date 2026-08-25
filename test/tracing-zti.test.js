/**
 * Integration tests for ZTI + Tracing
 *
 * Tests the fix for: "HTTP instrumentation caches NoopTracer if TracerProvider isn't registered early"
 *
 * The problem: When ZTI credentials take ~10 seconds to load, HTTP instrumentation would cache
 * a NoopTracer before the real TracerProvider was registered, causing all traces to be lost.
 *
 * The solution: Register TracerProvider early with BufferingSpanProcessor, then add the real
 * exporter after ZTI credentials are ready.
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

  test('needsZTIWait() detects ZTI scenario correctly', () => {
    const { needsZTIWait } = require('../lib/zti')

    expect(needsZTIWait()).toBe(true)

    // Should return false if USE_ZTI=false
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
    delete require.cache[require.resolve('../lib/zti')]
    const { needsZTIWait: needsZTIWait2 } = require('../lib/zti')
    expect(needsZTIWait2()).toBe(false)
  })

  test('BufferingSpanProcessor buffers spans until delegate is set', async () => {
    // Create SVID files immediately (so ZTI succeeds)
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    // Setup minimal CDS env for tracing
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
        }
      }
    }

    const tracing = require('../lib/tracing')
    const { getResource } = require('../lib/utils')
    const resource = getResource()

    // Step 1: Create TracerProvider with buffering (simulating ZTI wait)
    const tracerProvider = tracing.createTracerProvider(resource)
    expect(tracerProvider).toBeDefined()
    expect(tracerProvider._bufferingProcessor).toBeDefined()

    // Step 2: Create spans BEFORE exporter is added (they should buffer)
    const tracer = trace.getTracer('test')
    const span1 = tracer.startSpan('test-span-1')
    span1.end()
    const span2 = tracer.startSpan('test-span-2')
    span2.end()

    // At this point, spans are in the buffer
    expect(tracerProvider._bufferingProcessor._buffer.length).toBe(2)

    // Step 3: Add exporter (simulating ZTI ready)
    tracing.addTracingExporter(tracerProvider)

    // Buffer should now be flushed
    expect(tracerProvider._bufferingProcessor._buffer.length).toBe(0)
    expect(tracerProvider._bufferingProcessor._delegate).toBeDefined()
  })

  test('TracerProvider is created before HTTP instrumentation in ZTI flow', async () => {
    // This test verifies the fix: TracerProvider must be registered BEFORE
    // HTTP instrumentation loads, otherwise HTTP caches NoopTracer

    // Create SVID files immediately
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

    // Initialize telemetry (this triggers the ZTI flow)
    const setup = require('../lib/index')
    await setup()

    // Verify we can get a tracer (not NoopTracer)
    const tracer = trace.getTracer('test')
    expect(tracer).toBeDefined()

    // Create a span and verify it's a real span
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000') // NoopTracer returns zeros
    span.end()
  })

  test('ZTI initialization waits for SVID files with retry', async () => {
    // Don't create files immediately - test retry logic
    const { initializeZTI, _resetZTIState } = require('../lib/zti')
    _resetZTIState()

    // Start initialization (files don't exist yet)
    const initPromise = initializeZTI()

    // Wait 1 second, then create files (should succeed on retry)
    setTimeout(() => {
      fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
      fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
      fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')
    }, 1000)

    // Should eventually succeed (within retry timeout of 60 seconds)
    await expect(initPromise).resolves.not.toThrow()
  }, 65000) // Test timeout > retry timeout

  test('createTracerProvider and addTracingExporter work together', async () => {
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
        }
      }
    }

    const tracing = require('../lib/tracing')
    const { getResource } = require('../lib/utils')
    const { initializeZTI } = require('../lib/zti')
    const resource = getResource()

    // Simulate ZTI flow
    // 1. Create TracerProvider early
    const tracerProvider = tracing.createTracerProvider(resource)
    expect(tracerProvider).toBeDefined()

    // 2. Wait for ZTI
    await initializeZTI()

    // 3. Add exporter
    tracing.addTracingExporter(tracerProvider)

    // Verify the buffering processor got a delegate
    expect(tracerProvider._bufferingProcessor._delegate).toBeDefined()
  })

  test('ZTI flow updates instrumentations with meterProvider and loggerProvider', async () => {
    // This test verifies the fix for: instrumentations not receiving meterProvider/loggerProvider
    // when created before ZTI credentials are ready.
    //
    // The problem: In the ZTI path, registerInstrumentations() was called with
    // meterProvider: undefined and loggerProvider: undefined BEFORE those providers
    // were created, causing metrics and logs to not be exported.

    // Create SVID files immediately
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

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
        metrics: {
          exporter: {
            module: '@opentelemetry/sdk-metrics',
            class: 'InMemoryMetricExporter'
          },
          config: {}
        },
        logging: {
          exporter: {
            module: '@opentelemetry/sdk-logs',
            class: 'InMemoryLogRecordExporter'
          }
        },
        instrumentations: {}
      }
    }

    // Verify ZTI is needed
    delete require.cache[require.resolve('../lib/zti')]
    const { needsZTIWait, _resetZTIState } = require('../lib/zti')
    _resetZTIState()
    expect(needsZTIWait()).toBe(true)

    // Run setup
    delete require.cache[require.resolve('../lib/index')]
    const setup = require('../lib/index')
    await setup()

    // Verify meterProvider was set globally (this is what the fix ensures)
    const { metrics } = require('@opentelemetry/api')
    const meterProvider = metrics.getMeterProvider()
    expect(meterProvider).toBeDefined()
    expect(meterProvider.constructor.name).not.toBe('NoopMeterProvider')

    // Verify loggerProvider was set globally
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    expect(loggerProvider).toBeDefined()
    expect(loggerProvider.constructor.name).not.toBe('NoopLoggerProvider')
  })

  test('standard flow works without ZTI', async () => {
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
    const { needsZTIWait } = require('../lib/zti')

    // Should NOT need ZTI wait (no ZTI binding)
    expect(needsZTIWait()).toBe(false)

    // Standard setup should work
    const setup = require('../lib/index')
    await setup()

    const tracer = trace.getTracer('test')
    const span = tracer.startSpan('test-span')
    expect(span.spanContext().traceId).toBeDefined()
    span.end()
  })
})
