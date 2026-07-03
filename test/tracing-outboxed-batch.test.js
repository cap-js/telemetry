// Tests that when the queue worker picks up multiple ready tasks in one iteration
// (chunkSize > 1), each is dispatched in its own tx span under the SAME worker root.
// This validates the parallel-fan-out shape described in the design notes.

const cds = require('@sap/cds')
const { expect, POST } = cds.test(__dirname + '/bookshop', '--with-mocks', '--profile', 'tracing-in-memory')
const { reset, captured, groupedByTrace, rootSpans } = require('./bookshop/lib/MyInMemorySpanExporter')

const wait = require('node:timers/promises').setTimeout

describe('tracing for outboxed batch (chunk-size fan-out)', () => {
  if (cds.version.split('.')[0] < 9) {
    test.skip('skipping for cds < 9', () => {})
    return
  }

  beforeAll(async () => {
    const externalOne = await cds.connect.to('ExternalServiceOne')
    externalOne.on('call', () => 'ok')
  })

  beforeEach(reset)

  test('three queued sends produce parallel dispatch spans under one worker root', async () => {
    await POST('/odata/v4/admin/test_outboxed_send_batch', {}, { auth: { username: 'alice' } })
    await wait(2500)

    // Producer wrote three rows to the outbox.
    const upserts = captured.filter(s => s.name === 'db - UPSERT cds.outbox.Messages')
    expect(upserts.length, 'expected three producer outbox UPSERTs').to.be.gte(3)

    // Look for a queue worker root containing multiple dispatch tx spans.
    const workerTrace = groupedByTrace().find(g =>
      g.root.name === 'cds.spawn - run task' &&
      g.all.filter(s => s.name === 'ExternalServiceOne - tx').length >= 2
    )
    expect(workerTrace, 'expected a worker trace with multiple ExternalServiceOne - tx children').to.exist

    // The worker root must have exactly one lock tx (db - tx with READ + UPDATE)…
    const lockTxs = workerTrace.all.filter(s =>
      s.name === 'db - tx' &&
      workerTrace.all.some(c => c.parentSpanContext?.spanId === s.spanContext().spanId && c.name === 'db - READ cds.outbox.Messages')
    )
    expect(lockTxs, 'expected one lock tx (db - tx with READ + UPDATE)').to.have.lengthOf(1)

    // …and multiple dispatch txs, each containing an ExternalServiceOne handle span + DELETE.
    const dispatchTxs = workerTrace.all.filter(s => s.name === 'ExternalServiceOne - tx')
    expect(dispatchTxs.length, 'expected multiple dispatch txs (chunk-size fan-out)').to.be.gte(2)
    for (const tx of dispatchTxs) {
      const kids = workerTrace.all.filter(k => k.parentSpanContext?.spanId === tx.spanContext().spanId)
      expect(kids.some(k => k.name.match(/ExternalServiceOne - handle/)), 'dispatch tx should contain handle call').to.be.true
      expect(kids.some(k => k.name === 'db - DELETE cds.outbox.Messages'), 'dispatch tx should contain DELETE').to.be.true
    }

    // The dispatch txs should overlap in time (parallel), not be strictly sequential.
    if (dispatchTxs.length >= 2) {
      const sorted = [...dispatchTxs].sort((a, b) =>
        require('@opentelemetry/core').hrTimeToNanoseconds(a.startTime) -
        require('@opentelemetry/core').hrTimeToNanoseconds(b.startTime)
      )
      const { hrTimeToNanoseconds } = require('@opentelemetry/core')
      const firstEndNs = hrTimeToNanoseconds(sorted[0].endTime)
      const secondStartNs = hrTimeToNanoseconds(sorted[1].startTime)
      // Parallel: second starts before first ends (allow a tiny slack).
      expect(secondStartNs, 'expected parallel dispatch: task2 starts before task1 ends').to.be.lessThan(firstEndNs)
    }
  })
})
