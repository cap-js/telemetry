// Tests tracing of scheduled tasks.
//
// `cds.queued(svc).schedule('event', ...).after(N)` writes a task row to the persistent
// outbox with a timestamp N ms in the future. The queue scheduler picks it up at that
// time and dispatches to the target service's handler.
//
// Expected meaningful roots (unified across sqlite and HANA):
//
//   1. POST (incoming SERVER span)             (producer trace)
//        └─ AdminService - tx
//             └─ AdminService - handle test_scheduled
//                  └─ db - UPSERT cds.outbox.Messages
//                       └─ cds.spawn - schedule task
//
//   2. cds.spawn - run task                    (queue worker root)
//        ├─ db - tx                            (tx 1: lock)
//        └─ ExternalServiceOne - tx            (tx 2: dispatch)
//
// Plus optionally one bookkeeping startup-scan trace (tolerated, not required).
// Total meaningful roots: between 2 and 3.

const cds = require('@sap/cds')
const { expect, POST } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'tracing-in-memory')
const { reset, captured, groupedByTrace, rootSpans } = require('./bookshop/lib/MyInMemorySpanExporter')
const otel = require('@opentelemetry/api')
const { suppressTracing } = require('@opentelemetry/core')

const wait = require('node:timers/promises').setTimeout

// With incoming HTTP instrumentation on, the in-process test client would otherwise emit its own
// outgoing CLIENT span for the POST — an artifact that pollutes the producer trace and can even be
// picked as its root. Real callers are separate, un-instrumented processes, so run client requests
// under suppressTracing to model that: the CLIENT span is skipped and the genuine incoming SERVER
// span is the producer trace's root.
const asExternalClient = fn => otel.context.with(suppressTracing(otel.context.active()), fn)

// Force-flush the tracer provider's span processor so any spans buffered by background
// queue/worker activity are exported into `captured`. The global provider is a
// ProxyTracerProvider (no forceFlush) whose delegate is the real NodeTracerProvider;
// guard for the no-op provider so a misconfigured profile fails loudly, not silently.
async function flushSpans() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush()
}

// State-based wait: repeatedly flush + re-run the assertion until it holds or times out.
// Replaces fixed `wait(...)` sleeps that flake on HANA, where the worker flushes spans after
// the sleep window.
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

describe('tracing for scheduled tasks', () => {
  // Queue-worker spans (cds.spawn - run task root) require @sap/cds to route the sqlite
  // queue worker through cds.spawn. Published cds uses a raw setTimeout bypass on sqlite
  // (to avoid a single-writer deadlock), so those spans never appear. Skip until the cds
  // fix lands (cap/cds test/queue-spawn-sqlite-extended-tenant). REMOVE with follow-up PR.
  // Detect the DB via the env var set by vitest.config.mjs for the HANA job, NOT via cds.env:
  // reading cds.env at collection time would freeze the singleton before cds.test() applies its
  // `--profile`, so the tracer provider would be built with the default ConsoleSpanExporter and
  // MyInMemorySpanExporter would never receive spans (captured stays empty).
  if (!process.env.TELEMETRY_TEST_HANA) {
    test.skip('queue-worker tracing needs cds.spawn on sqlite (pending cds fix)', () => {})
    return
  }

  beforeAll(async () => {
    const externalOne = await cds.connect.to('ExternalServiceOne')
    externalOne.on('call', () => 'ok')
  })

  beforeEach(async () => {
    // Clear outbox rows left by a prior test file BEFORE resetting the span buffer — the HANA
    // HDI container is shared across all files, so a leftover message would be dispatched by this
    // file's worker and add a foreign `cds.spawn - run task` root. Reset AFTER so the DELETE's own
    // spans aren't captured. (No-op on sqlite: per-file in-memory DB.)
    await DELETE.from('cds.outbox.Messages')
    reset()
  })

  test('schedule .after() is fully traced through the queue worker', async () => {
    await asExternalClient(() => POST('/odata/v4/admin/test_scheduled', {}, { auth: { username: 'alice' } }))

    // Poll (flush + re-check) until the scheduled task has fired and all spans have been
    // exported; on HANA the worker latency exceeds any reasonable fixed sleep.
    await eventually(() => {
      // Producer trace: writes the task row inside the HTTP request tx.
      const producer = groupedByTrace().find(g => g.all.some(s => s.name === 'AdminService - handle test_scheduled'))
      expect(producer, 'expected a producer trace').to.exist
      // With incoming HTTP instrumentation on, the producer trace roots at the incoming SERVER
      // span for the POST; `AdminService - tx` now nests under it.
      expect(producer.root.kind, 'producer trace rooted at the incoming SERVER span').to.equal(otel.SpanKind.SERVER)
      expect(producer.all.some(s => s.name === 'AdminService - tx')).to.be.true
      expect(producer.all.some(s => s.name === 'db - UPSERT cds.outbox.Messages')).to.be.true
      expect(producer.all.some(s => s.name === 'cds.spawn - schedule task')).to.be.true

      // Queue worker trace: rooted at cds.spawn - run task, contains both tx spans.
      const workerTrace = groupedByTrace().find(g => g.root.name === 'cds.spawn - run task')
      expect(workerTrace, 'expected a queue-worker spawn-root trace').to.exist
      expect(workerTrace.all.some(s => s.name === 'db - tx')).to.be.true
      expect(workerTrace.all.some(s => s.name === 'ExternalServiceOne - tx')).to.be.true

      // The ExternalServiceOne handler was invoked.
      expect(captured.some(s => s.name.match(/ExternalServiceOne - handle/))).to.be.true

      // Total meaningful roots: producer + worker (+ optional bookkeeping scan).
      expect(rootSpans().length).to.be.gte(2)
      expect(rootSpans().length).to.be.lte(3)
    })
  })
})
