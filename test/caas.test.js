const cds = require('@sap/cds')
const fs = require('fs')
const os = require('os')
const path = require('path')

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
  })

  test('sets baseUrl from otlp.http', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
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
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeDefined()
    expect(credentials.httpAgentOptions.cert).toContain('BEGIN CERTIFICATE')
    expect(credentials.httpAgentOptions.key).toContain('BEGIN PRIVATE KEY')
    expect(credentials.httpAgentOptions.keepAlive).toBe(true)
  })

  test('throws when no OTLP endpoints', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
    const { augmentCaaSCreds } = require('../lib/utils')

    expect(() => augmentCaaSCreds({})).toThrow('No OTLP HTTP endpoint in CaaS credentials')
  })

  test('does not augment twice', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    delete require.cache[require.resolve('../lib/utils')]
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
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeUndefined()
  })
})

describe('ZTI SVID File Loading', () => {
  let tmpDir
  let svidDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zti-test-'))
    svidDir = path.join(tmpDir, 'spire-svids')
    fs.mkdirSync(svidDir)

    // Set up ZTI environment
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR = svidDir
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI

    cds.env.requires = cds.env.requires || {}
    cds.env.requires.telemetry = {}
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.VCAP_SERVICES
    delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
  })

  test('loads SVID files when they exist', () => {
    // Create SVID files
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    let creds
    jest.isolateModules(() => {
      const { getCredsForCaaSMtls } = require('../lib/utils')
      creds = getCredsForCaaSMtls()
    })

    expect(creds.status).toBe('ready')
    expect(creds.cert).toContain('BEGIN CERTIFICATE')
    expect(creds.key).toContain('BEGIN PRIVATE KEY')
  })

  test('returns null when SVID files do not exist', () => {
    // Don't create SVID files

    let creds
    jest.isolateModules(() => {
      const { getCredsForCaaSMtls } = require('../lib/utils')
      creds = getCredsForCaaSMtls()
    })

    expect(creds).toEqual({ status: 'not_ready' })
  })

  test('reloads when mtime changes', async () => {
    const certPath = path.join(svidDir, 'test-svid.svid.pem')
    const keyPath = path.join(svidDir, 'test-svid.svid.key')
    const bundlePath = path.join(svidDir, 'test-svid.bundle.pem')

    // Write initial files
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')
    fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv1\n-----END PRIVATE KEY-----')
    fs.writeFileSync(bundlePath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')

    let creds1, creds2
    await jest.isolateModulesAsync(async () => {
      const { getCredsForCaaSMtls } = require('../lib/utils')

      creds1 = getCredsForCaaSMtls()

      // Wait to ensure mtime changes (filesystem mtime resolution can be ~1s on some systems)
      await new Promise(resolve => setTimeout(resolve, 50))

      // Update files (simulating ZTI rotation)
      fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv2\n-----END CERTIFICATE-----')
      fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv2\n-----END PRIVATE KEY-----')

      creds2 = getCredsForCaaSMtls()
    })

    expect(creds1.status).toBe('ready')
    expect(creds1.cert).toContain('v1')
    expect(creds2.status).toBe('ready')
    expect(creds2.cert).toContain('v2')
    expect(creds2.key).toContain('v2')
  })
})

describe('ZTI flag behavior', () => {
  beforeEach(() => {
    cds.env.requires = { telemetry: {} }
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
    delete require.cache[require.resolve('../lib/utils')]
  })

  afterEach(() => {
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
    delete process.env.VCAP_SERVICES
  })

  test('detects ZTI config from VCAP_SERVICES', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)

    jest.isolateModules(() => {
      const { getZTIConfig } = require('../lib/zti')
      const config = getZTIConfig()

      expect(config).not.toBeNull()
      expect(config.svidName).toBe('test-svid')
      expect(config.svidDir).toBe('/home/vcap/app/spire-svids')
    })
  })

  test('returns null when no ZTI binding', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)

    jest.isolateModules(() => {
      const { getZTIConfig } = require('../lib/zti')
      const config = getZTIConfig()

      expect(config).toBeNull()
    })
  })

  test('uses env var credentials when USE_ZTI=false', () => {
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    cds.env.requires.telemetry.x509 = {
      cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar\n-----END CERTIFICATE-----').toString('base64'),
      key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar\n-----END PRIVATE KEY-----').toString('base64')
    }

    const { getCredsForCaaSMtls } = require('../lib/utils')
    const creds = getCredsForCaaSMtls()

    expect(creds).toBeDefined()
    // Env var credentials are still base64 at this point
    expect(Buffer.from(creds.cert, 'base64').toString()).toContain('envvar')
  })

  test('augmentCaaSCreds handles PEM format from ZTI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zti-test-'))
    const svidDir = path.join(tmpDir, 'spire-svids')
    fs.mkdirSync(svidDir)

    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR = svidDir

    // Create SVID files
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\nzti-cert\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\nzti-key\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    jest.isolateModules(() => {
      const { augmentCaaSCreds } = require('../lib/utils')

      const credentials = {
        otlp: { http: 'https://caas.example.com/otlp' }
      }
      augmentCaaSCreds(credentials)

      expect(credentials.httpAgentOptions).toBeDefined()
      expect(credentials.httpAgentOptions.cert).toContain('zti-cert')
      expect(credentials.httpAgentOptions.key).toContain('zti-key')
    })

    // Cleanup
    delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('augmentCaaSCreds handles base64 format from env vars', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
    cds.env.requires.telemetry.x509 = {
      cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar-cert\n-----END CERTIFICATE-----').toString('base64'),
      key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar-key\n-----END PRIVATE KEY-----').toString('base64')
    }

    // Env var fallback doesn't involve ZTI state
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }
    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeDefined()
    expect(credentials.httpAgentOptions.cert).toContain('envvar-cert')
    expect(credentials.httpAgentOptions.key).toContain('envvar-key')
  })
})

describe('LazyExporter', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../lib/exporter/LazyExporter')]
  })

  test('buffers items when exporter creation fails', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let createCalled = 0
    const lazyExporter = createLazyExporter(() => {
      createCalled++
      return { status: 'not_ready' }
    })

    const items = [{ name: 'span1' }, { name: 'span2' }]
    let callbackResult
    lazyExporter.export(items, result => { callbackResult = result })

    expect(callbackResult).toEqual({ code: 0 }) // SUCCESS
    expect(lazyExporter._getBufferSize()).toBe(1) // Items buffered as single array
    expect(lazyExporter._isExporterCreated()).toBe(false)
    expect(createCalled).toBe(1)
  })

  test('flushes buffer when exporter becomes ready', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let ready = false
    const exportedItems = []
    const mockExporter = {
      export: (items, cb) => {
        exportedItems.push(items)
        cb({ code: 0 })
      }
    }

    const lazyExporter = createLazyExporter(() => {
      if (!ready) return { status: 'not_ready' }
      return { status: 'ready', exporter: mockExporter }
    })

    // First export - buffers
    lazyExporter.export([{ name: 'span1' }], () => {})
    expect(lazyExporter._getBufferSize()).toBe(1)

    // Make exporter ready
    ready = true

    // Second export - should flush buffer and export new items
    lazyExporter.export([{ name: 'span2' }], () => {})

    expect(lazyExporter._isExporterCreated()).toBe(true)
    expect(lazyExporter._getBufferSize()).toBe(0)
    expect(exportedItems).toHaveLength(2) // buffered + new
    expect(exportedItems[0]).toEqual([{ name: 'span1' }])
    expect(exportedItems[1]).toEqual([{ name: 'span2' }])
  })

  test('respects maxBufferSize', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    const lazyExporter = createLazyExporter(
      () => { return { status: 'not_ready' } },
      { maxBufferSize: 2 }
    )

    // Fill buffer beyond max
    lazyExporter.export([{ name: 'span1' }], () => {})
    lazyExporter.export([{ name: 'span2' }], () => {})
    lazyExporter.export([{ name: 'span3' }], () => {})

    // Should only have 2 items (oldest dropped)
    expect(lazyExporter._getBufferSize()).toBe(2)
  })

  test('shutdown clears buffer', async () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    const lazyExporter = createLazyExporter(() => {
      return { status: 'not_ready' }
    })

    lazyExporter.export([{ name: 'span1' }], () => {})
    expect(lazyExporter._getBufferSize()).toBe(1)

    await lazyExporter.shutdown()
    expect(lazyExporter._getBufferSize()).toBe(0)
  })

  test('forceFlush creates exporter and flushes if ready', async () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let ready = false
    const exportedItems = []
    const mockExporter = {
      export: (items, cb) => {
        exportedItems.push(items)
        cb({ code: 0 })
      },
      forceFlush: jest.fn().mockResolvedValue()
    }

    const lazyExporter = createLazyExporter(() => {
      if (!ready) return { status: 'not_ready' }
      return { status: 'ready', exporter: mockExporter }
    })

    // Buffer some items
    lazyExporter.export([{ name: 'span1' }], () => {})

    // forceFlush when not ready - should not throw
    await lazyExporter.forceFlush()
    expect(lazyExporter._getBufferSize()).toBe(1) // Still buffered

    // Make ready and forceFlush
    ready = true
    await lazyExporter.forceFlush()

    expect(lazyExporter._isExporterCreated()).toBe(true)
    expect(lazyExporter._getBufferSize()).toBe(0)
    expect(exportedItems).toHaveLength(1)
    expect(mockExporter.forceFlush).toHaveBeenCalled()
  })

  test('does not retry after permanent failure', () => {
    const { createLazyExporter } = require('../lib/exporter/LazyExporter')

    let createCalled = 0
    const lazyExporter = createLazyExporter(() => {
      createCalled++
      return { status: 'error', error: 'Permanent configuration error' }
    })

    // First export - tries to create
    lazyExporter.export([{ name: 'span1' }], () => {})
    expect(createCalled).toBe(1)

    // Second export - should not retry (permanent failure)
    lazyExporter.export([{ name: 'span2' }], () => {})
    expect(createCalled).toBe(1) // Still 1, not retried
  })
})
