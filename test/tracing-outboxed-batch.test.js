// Tests that when the queue worker picks up multiple ready tasks in one iteration
// (chunkSize > 1), each is dispatched in its own tx span under the SAME worker root.
// This validates the parallel-fan-out shape described in the design notes.

const cds = require('@sap/cds')
const { expect, POST } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'tracing-in-memory')
const { reset, captured, groupedByTrace } = require('./bookshop/lib/MyInMemorySpanExporter')
const { hrTimeToNanoseconds } = require('@opentelemetry/core')
const otel = require('@opentelemetry/api')

const wait = require('node:timers/promises').setTimeout

// Force-flush the tracer provider's span processor so any spans buffered by background
// outbox/queue activity are exported into `captured`. The global provider is a
// ProxyTracerProvider (no forceFlush) whose delegate is the real NodeTracerProvider;
// guard for the no-op provider so a misconfigured profile fails loudly, not silently.
async function flushSpans() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush()
}

// State-based wait: repeatedly flush + re-run the assertion until it holds or times out.
// Replaces fixed `wait(...)` sleeps that flake on HANA, where background work flushes spans
// after the sleep window.
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

describe('tracing for outboxed batch (chunk-size fan-out)', () => {
  // Queue-worker spans need cds.spawn on sqlite (pending cds fix). REMOVE with follow-up PR.
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

  test('three queued sends produce parallel dispatch spans under one worker root', async () => {
    await POST('/odata/v4/admin/test_outboxed_send_batch', {}, { auth: { username: 'alice' } })

    await eventually(() => {
      // Producer wrote three rows to the outbox.
      const upserts = captured.filter(s => s.name === 'db - UPSERT cds.outbox.Messages')
      expect(upserts.length, 'expected three producer outbox UPSERTs').to.be.gte(3)

      // Look for a queue worker root containing multiple dispatch tx spans.
      const workerTrace = groupedByTrace().find(
        g =>
          g.root.name === 'cds.spawn - run task' && g.all.filter(s => s.name === 'ExternalServiceOne - tx').length >= 2
      )
      expect(workerTrace, 'expected a worker trace with multiple ExternalServiceOne - tx children').to.exist

      // The worker root must have exactly one lock tx (db - tx with READ + UPDATE)…
      const lockTxs = workerTrace.all.filter(
        s =>
          s.name === 'db - tx' &&
          workerTrace.all.some(
            c => c.parentSpanContext?.spanId === s.spanContext().spanId && c.name === 'db - READ cds.outbox.Messages'
          )
      )
      expect(lockTxs, 'expected one lock tx (db - tx with READ + UPDATE)').to.have.lengthOf(1)

      // …and multiple dispatch txs, each containing an ExternalServiceOne handle span + DELETE.
      const dispatchTxs = workerTrace.all.filter(s => s.name === 'ExternalServiceOne - tx')
      expect(dispatchTxs.length, 'expected multiple dispatch txs (chunk-size fan-out)').to.be.gte(2)
      for (const tx of dispatchTxs) {
        const kids = workerTrace.all.filter(k => k.parentSpanContext?.spanId === tx.spanContext().spanId)
        expect(
          kids.some(k => k.name.match(/ExternalServiceOne - handle/)),
          'dispatch tx should contain handle call'
        ).to.be.true
        expect(
          kids.some(k => k.name === 'db - DELETE cds.outbox.Messages'),
          'dispatch tx should contain DELETE'
        ).to.be.true
      }

      // The dispatch txs should overlap in time (parallel), not be strictly sequential.
      if (dispatchTxs.length >= 2) {
        const sorted = [...dispatchTxs].sort(
          (a, b) => hrTimeToNanoseconds(a.startTime) - hrTimeToNanoseconds(b.startTime)
        )
        const firstEndNs = hrTimeToNanoseconds(sorted[0].endTime)
        const secondStartNs = hrTimeToNanoseconds(sorted[1].startTime)
        // Parallel: second starts before first ends (allow a tiny slack).
        expect(secondStartNs, 'expected parallel dispatch: task2 starts before task1 ends').to.be.lessThan(firstEndNs)
      }
    })
  })
})
