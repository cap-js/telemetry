const cds = require('@sap/cds')

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
  }],
  'user-provided': [{
    name: 'caas-mtls-creds',
    credentials: {
      cert: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----').toString('base64'),
      key: Buffer.from('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----').toString('base64')
    },
    tags: []
  }]
}

const MOCK_CAAS_VCAP_NO_MTLS = {
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
    cds.env.requires.telemetry = { mtls_service_pattern: 'caas-mtls|caas-cert' }
    delete require.cache[require.resolve('../lib/utils')]
  })

  test('sets baseUrl and url from otlp.http', () => {
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
    expect(credentials.url).toBe('https://caas.example.com/otlp')
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

    expect(() => augmentCaaSCreds({})).toThrow('No OTLP endpoints found')
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
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_CAAS_VCAP_NO_MTLS)
    delete require.cache[require.resolve('../lib/utils')]
    const { augmentCaaSCreds } = require('../lib/utils')

    const credentials = {
      otlp: { http: 'https://caas.example.com/otlp' }
    }

    augmentCaaSCreds(credentials)

    expect(credentials.httpAgentOptions).toBeUndefined()
  })
})
