const fs = require('fs')
const os = require('os')
const path = require('path')

const MOCK_FROM_ENV = { 'some-service': [{ name: 'from-env' }] }
const MOCK_FROM_FILE = { 'some-service': [{ name: 'from-file' }] }

// getVcapServices() centralizes VCAP access: file-based bindings
// (VCAP_SERVICES_FILE_PATH) take precedence over the VCAP_SERVICES env var.
describe('getVcapServices', () => {
  let tmpDir, filePath
  let originalVcap, originalFilePath

  beforeAll(() => {
    originalVcap = process.env.VCAP_SERVICES
    originalFilePath = process.env.VCAP_SERVICES_FILE_PATH
  })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcap-test-'))
    filePath = path.join(tmpDir, 'vcap_services')
    delete process.env.VCAP_SERVICES
    delete process.env.VCAP_SERVICES_FILE_PATH
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.VCAP_SERVICES
    delete process.env.VCAP_SERVICES_FILE_PATH
    vi.resetModules()
  })

  afterAll(() => {
    if (originalVcap !== undefined) process.env.VCAP_SERVICES = originalVcap
    else delete process.env.VCAP_SERVICES
    if (originalFilePath !== undefined) process.env.VCAP_SERVICES_FILE_PATH = originalFilePath
    else delete process.env.VCAP_SERVICES_FILE_PATH
  })

  test('returns undefined when neither VCAP_SERVICES nor VCAP_SERVICES_FILE_PATH is set', async () => {
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(getVcapServices()).toBeFalsy()
  })

  test('parses VCAP_SERVICES when VCAP_SERVICES_FILE_PATH is not set', async () => {
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_FROM_ENV)
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(getVcapServices()).toEqual(MOCK_FROM_ENV)
  })

  test('reads from the file when VCAP_SERVICES_FILE_PATH is set', async () => {
    fs.writeFileSync(filePath, JSON.stringify(MOCK_FROM_FILE))
    process.env.VCAP_SERVICES_FILE_PATH = filePath
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(getVcapServices()).toEqual(MOCK_FROM_FILE)
  })

  test('file-based binding takes precedence over VCAP_SERVICES', async () => {
    fs.writeFileSync(filePath, JSON.stringify(MOCK_FROM_FILE))
    process.env.VCAP_SERVICES_FILE_PATH = filePath
    process.env.VCAP_SERVICES = JSON.stringify(MOCK_FROM_ENV)
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(getVcapServices()).toEqual(MOCK_FROM_FILE)
  })

  // A configured-but-broken file path is a misconfiguration we want to surface
  // loudly at startup rather than silently fall back to a stale/absent env var.
  test('throws when VCAP_SERVICES_FILE_PATH points to a missing file', async () => {
    process.env.VCAP_SERVICES_FILE_PATH = path.join(tmpDir, 'does-not-exist')
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(() => getVcapServices()).toThrow()
  })

  test('throws when the file contains malformed JSON', async () => {
    fs.writeFileSync(filePath, '{ not valid json')
    process.env.VCAP_SERVICES_FILE_PATH = filePath
    const { getVcapServices } = await import('../lib/utils/credentials.js')
    expect(() => getVcapServices()).toThrow()
  })
})
