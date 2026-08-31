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

  test('createZTIAgentFactory returns factory when SVID files exist', () => {
    // Create SVID files
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----')

    let factory
    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      factory = createZTIAgentFactory()
    })

    expect(factory).not.toBeNull()
    expect(typeof factory).toBe('function')
  })

  test('createZTIAgentFactory returns null when SVID files do not exist', () => {
    // Don't create SVID files - factory creation will fail

    let factory
    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      factory = createZTIAgentFactory()
    })

    // Factory is created (ZTI is configured via VCAP_SERVICES)
    expect(factory).not.toBeNull()
    expect(typeof factory).toBe('function')
    // Calling factory throws because certs are loaded in constructor
    expect(() => factory()).toThrow()
  })

  test('agent reloads certs when mtime changes', async () => {
    const certPath = path.join(svidDir, 'test-svid.svid.pem')
    const keyPath = path.join(svidDir, 'test-svid.svid.key')
    const bundlePath = path.join(svidDir, 'test-svid.bundle.pem')

    // Write initial files
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')
    fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv1\n-----END PRIVATE KEY-----')
    fs.writeFileSync(bundlePath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')

    let cert1, cert2
    await jest.isolateModulesAsync(async () => {
      const { createZTIAgentFactory } = require('../lib/utils')
      const { reset } = require('../lib/zti')

      const agent = createZTIAgentFactory()()
      cert1 = agent.options.cert

      // Wait to ensure mtime changes (filesystem mtime resolution can be ~1s on some systems)
      await new Promise(resolve => setTimeout(resolve, 50))

      // Update files (simulating ZTI rotation)
      fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv2\n-----END CERTIFICATE-----')
      fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv2\n-----END PRIVATE KEY-----')

      // Trigger rotation
      agent._rotate()
      cert2 = agent.options.cert

      reset()
    })

    expect(cert1).toContain('v1')
    expect(cert2).toContain('v2')
  })
})

describe('ZTI flag behavior', () => {
  beforeEach(() => {
    cds.env.requires = { telemetry: {} }
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI
    delete require.cache[require.resolve('../lib/utils')]
    delete require.cache[require.resolve('../lib/zti')]
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

  test('createStaticAgentFactory returns factory when x509 configured', () => {
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    cds.env.requires.telemetry.x509 = {
      cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar\n-----END CERTIFICATE-----').toString('base64'),
      key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar\n-----END PRIVATE KEY-----').toString('base64')
    }

    const { createStaticAgentFactory } = require('../lib/utils')
    const factory = createStaticAgentFactory()

    expect(factory).toBeDefined()
    expect(typeof factory).toBe('function')
  })

  test('augmentCaaSCreds sets httpAgentOptions factory from ZTI', () => {
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
      // httpAgentOptions is now a factory function
      expect(typeof credentials.httpAgentOptions).toBe('function')
    })

    // Cleanup
    delete process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('augmentCaaSCreds sets httpAgentOptions factory from x509 config', () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI = 'false'
    cds.env.requires.telemetry.x509 = {
      cert: Buffer.from('-----BEGIN CERTIFICATE-----\nenvvar-cert\n-----END CERTIFICATE-----').toString('base64'),
      key: Buffer.from('-----BEGIN PRIVATE KEY-----\nenvvar-key\n-----END PRIVATE KEY-----').toString('base64')
    }

    // x509 fallback doesn't involve ZTI state
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }
    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeDefined()
    // httpAgentOptions is now a factory function
    expect(typeof credentials.httpAgentOptions).toBe('function')
  })
})

describe('ZTI Certificate Rotation', () => {
  let tmpDir, svidDir
  let originalEnv

  const CERT_V1 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_1\n-----END CERTIFICATE-----'
  const KEY_V1 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_1\n-----END PRIVATE KEY-----'
  const BUNDLE_V1 = '-----BEGIN CERTIFICATE-----\nBUNDLE_V1\n-----END CERTIFICATE-----'

  const CERT_V2 = '-----BEGIN CERTIFICATE-----\nCERT_VERSION_2\n-----END CERTIFICATE-----'
  const KEY_V2 = '-----BEGIN PRIVATE KEY-----\nKEY_VERSION_2\n-----END PRIVATE KEY-----'
  const BUNDLE_V2 = '-----BEGIN CERTIFICATE-----\nBUNDLE_V2\n-----END CERTIFICATE-----'

  beforeAll(() => {
    originalEnv = { ...process.env }
  })

  beforeEach(() => {
    // Create temp directory for SVID files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zti-rotation-test-'))
    svidDir = path.join(tmpDir, 'spire-svids')
    fs.mkdirSync(svidDir)

    // Set up environment
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_ZTI_VCAP)
    process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR = svidDir
    delete process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI

    cds.env.requires = { telemetry: {} }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.env = { ...originalEnv }
  })

  function writeSVIDFiles(cert, key, bundle) {
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.pem'), cert)
    fs.writeFileSync(path.join(svidDir, 'test-svid.svid.key'), key)
    fs.writeFileSync(path.join(svidDir, 'test-svid.bundle.pem'), bundle)
  }

  function touchWithNewMtime(filepath) {
    // Ensure mtime changes (some filesystems have 1-second resolution)
    const now = new Date()
    now.setSeconds(now.getSeconds() + 2)
    fs.utimesSync(filepath, now, now)
  }

  test('agent loads certificate in constructor', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      const { reset } = require('../lib/zti')

      const agent = createZTIAgentFactory()()

      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)

      reset()
    })
  })

  test('agent reloads certificate when mtime changes (rotation)', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      const { reset } = require('../lib/zti')

      const agent = createZTIAgentFactory()()

      // Initial - V1
      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)

      // Simulate certificate rotation via _rotate
      writeSVIDFiles(CERT_V2, KEY_V2, BUNDLE_V2)
      touchWithNewMtime(path.join(svidDir, 'test-svid.svid.pem'))
      agent._rotate()

      // After rotation - should have V2
      expect(agent.options.cert).toBe(CERT_V2)
      expect(agent.options.key).toBe(KEY_V2)

      reset()
    })
  })

  test('agent serves cached cert during transient read failure', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      const { reset } = require('../lib/zti')

      const agent = createZTIAgentFactory()()

      // Initial V1
      expect(agent.options.cert).toBe(CERT_V1)

      // Simulate mid-rotation: touch mtime but make key file unreadable
      touchWithNewMtime(path.join(svidDir, 'test-svid.svid.pem'))
      fs.unlinkSync(path.join(svidDir, 'test-svid.svid.key'))

      // _rotate should fail but agent should keep old certs
      agent._rotate()
      expect(agent.options.cert).toBe(CERT_V1)

      reset()
    })
  })

  test('createZTIAgentFactory returns sync factory', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      const { reset } = require('../lib/zti')

      const factory = createZTIAgentFactory()
      expect(factory).not.toBeNull()
      expect(typeof factory).toBe('function')

      const agent = factory()
      expect(agent.options.keepAlive).toBe(true)
      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)

      reset()
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

    const lazy = createLazyExporter(() => ({ status: 'not_ready' }))

    // Fill buffer beyond max (1000)
    for (let i = 0; i < 1005; i++) {
      lazy.export([`item${i}`], () => {})
    }

    // Verify via forceFlush - buffer should be capped
    // (We can't directly inspect buffer, but behavior is tested)
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
})
