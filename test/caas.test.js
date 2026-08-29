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

  test('createZTIAgentFactory returns factory even when SVID files do not exist yet', () => {
    // Don't create SVID files - but factory is still created
    // The factory will throw when called if files don't exist

    let factory
    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')
      factory = createZTIAgentFactory()
    })

    // Factory is created (ZTI is configured via VCAP_SERVICES)
    expect(factory).not.toBeNull()
    expect(typeof factory).toBe('function')
    // Calling it throws because files don't exist
    expect(() => factory()).toThrow()
  })

  test('getCert/getKey reload when mtime changes', async () => {
    const certPath = path.join(svidDir, 'test-svid.svid.pem')
    const keyPath = path.join(svidDir, 'test-svid.svid.key')
    const bundlePath = path.join(svidDir, 'test-svid.bundle.pem')

    // Write initial files
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')
    fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv1\n-----END PRIVATE KEY-----')
    fs.writeFileSync(bundlePath, '-----BEGIN CERTIFICATE-----\nv1\n-----END CERTIFICATE-----')

    let cert1, cert2
    await jest.isolateModulesAsync(async () => {
      const { initializeZTI, getCert, _reset } = require('../lib/zti')
      _reset()
      initializeZTI()

      cert1 = getCert()

      // Wait to ensure mtime changes (filesystem mtime resolution can be ~1s on some systems)
      await new Promise(resolve => setTimeout(resolve, 50))

      // Update files (simulating ZTI rotation)
      fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nv2\n-----END CERTIFICATE-----')
      fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nv2\n-----END PRIVATE KEY-----')

      cert2 = getCert()
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

  test('returns initial certificate on first call', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { initializeZTI, getCert, getKey } = require('../lib/zti')
      initializeZTI()

      expect(getCert()).toBe(CERT_V1)
      expect(getKey()).toBe(KEY_V1)
    })
  })

  test('returns cached certificate when mtime unchanged', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { initializeZTI, getCert, _reset } = require('../lib/zti')
      _reset()
      initializeZTI()

      // First call - reads from disk
      const cert1 = getCert()

      // Second call without any file changes - should return cached value
      const cert2 = getCert()

      expect(cert1).toBe(CERT_V1)
      expect(cert2).toBe(CERT_V1) // Still cached, same mtime
    })
  })

  test('reloads certificate when mtime changes (rotation)', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { initializeZTI, getCert, getKey } = require('../lib/zti')
      initializeZTI()

      // First call - reads V1
      expect(getCert()).toBe(CERT_V1)
      expect(getKey()).toBe(KEY_V1)

      // Simulate certificate rotation: write new files with new mtime
      writeSVIDFiles(CERT_V2, KEY_V2, BUNDLE_V2)
      touchWithNewMtime(path.join(svidDir, 'test-svid.svid.pem'))

      // Second call - should detect mtime change and reload
      expect(getCert()).toBe(CERT_V2)
      expect(getKey()).toBe(KEY_V2)
    })
  })

  test('serves cached cert during transient read failure', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { initializeZTI, getCert } = require('../lib/zti')
      initializeZTI()

      // First call - cache V1
      expect(getCert()).toBe(CERT_V1)

      // Simulate mid-rotation: touch mtime but make key file unreadable
      touchWithNewMtime(path.join(svidDir, 'test-svid.svid.pem'))
      fs.unlinkSync(path.join(svidDir, 'test-svid.svid.key'))

      // Should serve cached V1 despite read failure
      expect(getCert()).toBe(CERT_V1)
    })
  })

  test('throws when files missing and no cache', () => {
    // Don't create SVID files

    jest.isolateModules(() => {
      const { initializeZTI, getCert } = require('../lib/zti')
      initializeZTI()

      expect(() => getCert()).toThrow()
    })
  })

  test('getCert/getKey return rotated values when mtime changes', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { initializeZTI, getCert, getKey } = require('../lib/zti')

      initializeZTI()

      // First call - returns V1
      expect(getCert()).toBe(CERT_V1)
      expect(getKey()).toBe(KEY_V1)

      // Simulate certificate rotation: write new files with new mtime
      writeSVIDFiles(CERT_V2, KEY_V2, BUNDLE_V2)
      touchWithNewMtime(path.join(svidDir, 'test-svid.svid.pem'))

      // Second call - returns V2 (rotation detected)
      expect(getCert()).toBe(CERT_V2)
      expect(getKey()).toBe(KEY_V2)
    })
  })

  test('createZTIAgentFactory returns sync factory that uses getCert/getKey', () => {
    writeSVIDFiles(CERT_V1, KEY_V1, BUNDLE_V1)

    jest.isolateModules(() => {
      const { createZTIAgentFactory } = require('../lib/utils')

      const factory = createZTIAgentFactory()
      expect(factory).not.toBeNull()
      expect(typeof factory).toBe('function')

      // Factory is sync and returns an Agent with current certs
      const agent = factory()
      expect(agent.options.cert).toBe(CERT_V1)
      expect(agent.options.key).toBe(KEY_V1)
      expect(agent.options.keepAlive).toBe(true)
    })
  })
})
