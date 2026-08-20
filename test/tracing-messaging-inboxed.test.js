const CASE = 'inboxed'

const otel = require('@opentelemetry/api')

// `inboxed: true` combined with the default outboxed messaging behavior means TWO queue
// workers get involved per emit — one on the producer side (drains outbox to broker) and
// one on the consumer side (drains inbox to subscribers). Each worker runs two
// transactions (tx 1: lock; tx 2: handle + delete).
//
// Each worker iteration is wrapped by `cds.spawn`, so both txs collapse under a single
// `cds.spawn - run task` root. With incoming HTTP instrumentation on, the producer trace is
// rooted at the incoming SERVER span for the emit-triggering POST (AdminService - tx nests
// under it). 4 meaningful roots:
//
//   1. POST (incoming SERVER span)          (producer: AdminService - tx, handle test_emit, UPSERT outbox)
//   2. cds.spawn - run task                  (outbox worker: dispatches to file)
//        ├─ db - tx        (tx 1: lock)
//        └─ messaging - tx (tx 2: handle foo — writes to file — + DELETE)
//   3. messaging - tx                        (file-based CONSUMER: writes inbox row)
//        └─ ...enqueue into inbox...
//   4. cds.spawn - run task                  (inbox worker: runs subscriber)
//        ├─ db - tx        (tx 1: lock)
//        └─ messaging - tx (tx 2: handle foo — SELECT Books — + DELETE)
//
// Tolerated: allow one extra root for the scheduling-service bookkeeping startup scan.

// Messaging config (kind/file/inboxed) comes from the `inboxed` profile in
// test/bookshop/.cdsrc.json, composed with `tracing-in-memory` by the shared harness.
const CHECK = ({ expect, rootSpans, groupedByTrace }) => {
  // Producer trace
  const producer = groupedByTrace.find(g => g.all.some(s => s.name === 'AdminService - handle test_emit'))
  expect(producer, 'expected a producer trace').to.exist
  expect(producer.root.kind, 'producer trace rooted at the incoming SERVER span').to.equal(otel.SpanKind.SERVER)
  expect(producer.all.some(s => s.name === 'AdminService - tx')).to.be.true
  expect(producer.all.some(s => s.name === 'db - UPSERT cds.outbox.Messages')).to.be.true

  // The inbox worker must have run the application handler (SELECT Books).
  const allSpans = groupedByTrace.flatMap(g => g.all)
  expect(allSpans.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/))).to.be.true
  expect(allSpans.some(s => s.name === 'db - DELETE cds.outbox.Messages')).to.be.true

  // Exactly two `cds.spawn - run task` roots (outbox worker + inbox worker).
  const workerRoots = rootSpans.filter(s => s.name === 'cds.spawn - run task')
  expect(workerRoots, 'expected two queue-worker spawn roots (outbox + inbox)').to.have.lengthOf(2)

  // One of the spawn roots (the inbox worker) ran the app handler.
  const inboxWorker = groupedByTrace.find(
    g => g.root.name === 'cds.spawn - run task' && g.all.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/))
  )
  expect(inboxWorker, 'expected an inbox-worker trace that ran the application handler').to.exist

  // 4 meaningful roots (+1 tolerated bookkeeping scan).
  expect(rootSpans.length).to.be.gte(4)
  expect(rootSpans.length).to.be.lte(5)
}

describe(`tracing messaging - ${CASE}`, () => {
  // Queue-worker spans need cds.spawn on sqlite (pending cds fix). REMOVE with follow-up PR.
  // Detect the DB via the env var set by vitest.config.mjs for the HANA job, NOT via cds.env:
  // reading cds.env at collection time would freeze the singleton before cds.test() applies its
  // `--profile`, so the tracer provider would be built with the default ConsoleSpanExporter and
  // MyInMemorySpanExporter would never receive spans.
  if (!process.env.TELEMETRY_TEST_HANA) {
    test.skip('queue-worker tracing needs cds.spawn on sqlite (pending cds fix)', () => {})
    return
  }
  require('./tracing-messaging')(CASE, CHECK)
})
