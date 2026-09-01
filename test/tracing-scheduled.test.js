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
const { asExternalClient, eventually } = require('./utils')

describe('tracing for scheduled tasks', () => {
  // Queue-worker tracing needs cds.spawn on sqlite — skipped here, tracked in #477 §1.
  // See TESTING.md → Sanctioned skips (and HANA signalling: why we branch on TELEMETRY_TEST_HANA, not cds.env).
  if (!process.env.TELEMETRY_TEST_HANA) {
    test.skip('queue-worker tracing needs cds.spawn on sqlite (pending cds fix)', () => {})
    return
  }

  beforeAll(async () => {
    const externalOne = await cds.connect.to('ExternalServiceOne')
    externalOne.on('call', () => 'ok')
  })

  beforeEach(async () => {
    // Clear the shared outbox before resetting the span buffer; no-op on sqlite.
    // See TESTING.md → sqlite vs HANA (outbox bleed on the shared HANA container).
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
