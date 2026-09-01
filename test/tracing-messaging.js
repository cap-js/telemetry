module.exports = (CASE, CHECK) => {
  const cds = require('@sap/cds')
  const { expect, POST } = cds.test(__dirname + '/bookshop', '--profile', `${CASE},tracing-in-memory`)
  const { reset, groupedByTrace, captured } = require('./bookshop/lib/MyInMemorySpanExporter')
  const { asExternalClient, clearOutbox, eventually, meaningful } = require('./utils')

  const wait = require('node:timers/promises').setTimeout

  const admin = { auth: { username: 'alice' } }

  const rm = () => {
    try {
      require('fs').rmSync(require('path').join(__dirname, CASE))
    } catch {
      // ignore
    }
  }

  beforeAll(async () => {
    rm()
    await wait(100)
  })

  afterAll(async () => {
    // HANA-only outbox settle so a draining worker can't bleed into the next file; no-op on sqlite.
    // See TESTING.md → sqlite vs HANA (outbox bleed on the shared HANA container).
    if (process.env.TELEMETRY_TEST_HANA) {
      await clearOutbox()
      await wait(5000)
      await clearOutbox()
    }
    rm()
  })

  beforeEach(async () => {
    // Clear the shared outbox before resetting the span buffer; no-op on sqlite.
    // See TESTING.md → sqlite vs HANA (outbox bleed on the shared HANA container).
    await clearOutbox()
    reset()
  })

  test('emit is traced', async () => {
    await asExternalClient(() => POST('/odata/v4/admin/test_emit', {}, admin))
    // Poll (flush + re-check) until both queue workers have run and exported their spans;
    // on HANA the worker latency exceeds any reasonable fixed sleep. Pass the meaningful
    // (non-outbox-scan) traces so the CHECK's exact root-count assertions aren't thrown off by
    // the scheduler's bookkeeping scans on the shared HANA container.
    await eventually(() => {
      const groups = meaningful(groupedByTrace())
      const roots = groups.flatMap(g => g.roots)
      // CHECK is called with span-level data: { expect, rootSpans, groupedByTrace, captured, cds }
      CHECK({ expect, rootSpans: roots, groupedByTrace: groups, captured: [...captured], cds })
    })
  })
}
