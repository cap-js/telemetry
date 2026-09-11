/**
 * Tests for wrapExporterWithBuffer - isolated in separate file for clean process isolation.
 * These tests manipulate the cds.env singleton which persists across vi.resetModules() calls.
 * Tests use static x509 certs (ZTI disabled) to test buffering behavior.
 */
const cds = require('@sap/cds')

describe('wrapExporterWithBuffer', () => {
  beforeEach(() => {
    vi.resetModules()
    // Clear env vars that affect ZTI detection
    delete process.env.VCAP_SERVICES
    delete process.env.TELEMETRY_ZTI_DIR
    // Disable ZTI to test static x509 cert path
    process.env.TELEMETRY_USE_ZTI = 'false'
    // Clear cds.env singleton - especially x509 certs from prior tests
    cds.env.requires = { telemetry: {} }
  })

  afterEach(() => {
    delete process.env.TELEMETRY_USE_ZTI
  })

  test('buffers items until certs are available', async () => {
    const { wrapExporterWithBuffer } = await import('../lib/utils.js')

    const exportedItems = []
    const mockExporter = {
      export: vi.fn((items, cb) => {
        exportedItems.push(...items)
        cb({ code: 0 })
      }),
      shutdown: vi.fn(() => Promise.resolve())
    }

    const wrapped = wrapExporterWithBuffer(mockExporter)

    // Export while not ready - should buffer
    wrapped.export(['item1'], () => {})
    wrapped.export(['item2'], () => {})
    expect(exportedItems.length).toBe(0)

    // Make certs available
    cds.env.requires.telemetry.x509 = {
      cert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
    }

    // Next export triggers flush + new export
    wrapped.export(['item3'], () => {})
    expect(exportedItems).toEqual(['item1', 'item2', 'item3'])
  })

  test('drops oldest when buffer full', async () => {
    const { wrapExporterWithBuffer } = await import('../lib/utils.js')

    const exportedItems = []
    const mockExporter = {
      export: vi.fn((items, cb) => {
        exportedItems.push(...items)
        cb({ code: 0 })
      })
    }

    const wrapped = wrapExporterWithBuffer(mockExporter)

    // Fill buffer beyond max (10)
    for (let i = 0; i < 15; i++) {
      wrapped.export([`item${i}`], () => {})
    }

    // Make certs available and trigger flush
    cds.env.requires.telemetry.x509 = {
      cert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
    }
    wrapped.export(['final'], () => {})

    // Buffer was capped at 10, so oldest 5 items were dropped
    // Exported: 10 buffered + 1 final = 11
    expect(exportedItems.length).toBe(11)
    expect(exportedItems[0]).toBe('item5') // item0-4 were dropped
    expect(exportedItems[9]).toBe('item14')
    expect(exportedItems[10]).toBe('final')
  })

  test('exports directly when certs already available', async () => {
    cds.env.requires = {
      telemetry: {
        x509: {
          cert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
          key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
        }
      }
    }

    const { wrapExporterWithBuffer } = await import('../lib/utils.js')

    const exportedItems = []
    const mockExporter = {
      export: vi.fn((items, cb) => {
        exportedItems.push(...items)
        cb({ code: 0 })
      })
    }

    const wrapped = wrapExporterWithBuffer(mockExporter)

    // Should export directly, no buffering
    wrapped.export(['item1'], () => {})
    expect(exportedItems).toEqual(['item1'])

    wrapped.export(['item2'], () => {})
    expect(exportedItems).toEqual(['item1', 'item2'])
  })

  test('after certs available, exports go directly to original (no buffer)', async () => {
    const { wrapExporterWithBuffer } = await import('../lib/utils.js')

    const exportCalls = []
    const mockExporter = {
      export: (items, cb) => {
        exportCalls.push(items)
        cb({ code: 0 })
      }
    }

    const wrapped = wrapExporterWithBuffer(mockExporter)

    // Buffer while not ready
    wrapped.export(['item1'], () => {})
    expect(exportCalls.length).toBe(0)

    // Make certs available
    cds.env.requires.telemetry.x509 = {
      cert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
    }

    // First export after certs: flushes buffer + exports new item
    wrapped.export(['item2'], () => {})
    expect(exportCalls).toEqual([['item1'], ['item2']])

    // Subsequent exports go directly (no re-checking certsAvailable)
    wrapped.export(['item3'], () => {})
    wrapped.export(['item4'], () => {})
    expect(exportCalls).toEqual([['item1'], ['item2'], ['item3'], ['item4']])
  })
})
