module.exports = (CASE, CHECK) => {
  const cds = require('@sap/cds')
  const { expect, POST } = cds.test(__dirname + '/bookshop', '--profile', `${CASE},tracing-in-memory`)
  const { reset, groupedByTrace, captured } = require('./bookshop/lib/MyInMemorySpanExporter')
  const otel = require('@opentelemetry/api')

  const wait = require('node:timers/promises').setTimeout

  // Force-flush the tracer provider's span processor so any spans buffered by background
  // queue-worker activity are exported into `captured`. The global provider is a
  // ProxyTracerProvider (no forceFlush) whose delegate is the real NodeTracerProvider;
  // guard for the no-op provider so a misconfigured profile fails loudly, not silently.
  async function flushSpans() {
    const provider = otel.trace.getTracerProvider()
    const delegate = provider.getDelegate?.() ?? provider
    if (typeof delegate.forceFlush === 'function') await delegate.forceFlush()
  }

  // State-based wait: repeatedly flush + re-run the assertion until it holds or times out.
  // Replaces the fixed `wait(waitMs)` sleep that flakes on HANA, where the two queue workers
  // flush their spans well after any reasonable fixed window.
  async function eventually(fn, { timeout = 15000, interval = 50 } = {}) {
    const start = Date.now()
    let lastError
    while (true) {
      await flushSpans()
      try {
        await fn()
        return
      } catch (err) {
        lastError = err
        if (Date.now() - start >= timeout) throw lastError
        await wait(interval)
      }
    }
  }

  const admin = { auth: { username: 'alice' } }

  // The queue scheduler periodically scans `cds.outbox.Messages` in its own `db - tx` (a
  // SELECT + optional UPDATE that finds nothing to dispatch). On HANA these bookkeeping scans
  // land as extra root traces that have nothing to do with the emit under test — and because
  // the single HDI container is shared across all test files, scans triggered by other files'
  // lingering workers show up too. Filter those pure outbox-scan traces so the CHECKs' exact
  // root-count assertions stay stable. A scan trace is a `db - tx` root whose every span only
  // touches `cds.outbox.Messages` (no application entity, no messaging/handle span).
  const isOutboxScanTrace = g =>
    g.root.name === 'db - tx' && g.all.every(s => s.name === 'db - tx' || s.name.includes('cds.outbox.Messages'))
  const meaningful = groups => groups.filter(g => !isOutboxScanTrace(g))

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
    // On the shared HANA HDI container, a still-draining background queue worker from THIS file
    // would dispatch into the NEXT file's run and add foreign `cds.spawn - run task` roots that
    // break its exact root-count CHECKs. Clear the shared outbox, let the last worker settle, then
    // clear again. HANA-only: sqlite gets a fresh in-memory DB per file, so the settle is
    // pointless there AND a 10s wait would trip sqlite's 10s hookTimeout. (hookTimeout is raised
    // on the HANA CI path in vitest.config.mjs to accommodate this.)
    if (cds.env.requires.db?.kind === 'hana') {
      try {
        await DELETE.from('cds.outbox.Messages')
      } catch {
        // pool draining during shutdown — nothing left to clean matters
      }
      await wait(10000)
      try {
        await DELETE.from('cds.outbox.Messages')
      } catch {
        // ignore
      }
    }
    rm()
  })

  beforeEach(async () => {
    // Clear any outbox rows left behind by a prior test file BEFORE resetting the span buffer.
    // The single HANA HDI container is shared across all files, so a leftover message would be
    // dispatched by THIS file's queue worker — producing a foreign `cds.spawn - run task` root
    // that breaks the exact root-count CHECKs. Reset AFTER so the DELETE's own spans aren't
    // captured. (No-op on sqlite, where each file gets its own in-memory DB.)
    await DELETE.from('cds.outbox.Messages')
    reset()
  })

  test('emit is traced', async () => {
    await POST('/odata/v4/admin/test_emit', {}, admin)
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
