const CASE = 'persistent-outbox'

// REVISIT: even with profile "persistent-outbox", messaging kind and file from package.json wins
process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`
})

// --- Span hierarchy for the persistent-outbox case ---------------------------------------
//
// With persistent outbox enabled, the queue worker runs two coherent transactions:
//   - tx 1: read out of queue + set status='processing'  (libx/queue/processing.js:189)
//   - tx 2: handle the event + delete the row             (libx/queue/processing.js:319)
//
// `@cap-js/telemetry` wraps `cds.tx(fn)` to emit a `<service> - tx` span per callback, so
// each of these transactions is captured as a root/child span. Both sqlite and HANA now
// produce the same unified shape: the worker uses `cds.spawn`, which the telemetry plugin
// wraps to emit a single `cds.spawn - run task` CONSUMER root that both worker tx spans
// nest under.
//
// Expected shape (3 meaningful roots, same for sqlite and HANA):
//
//   1. AdminService - tx                          (producer trace)
//        └─ AdminService - handle test_emit
//             └─ messaging - emit outgoing foo
//                  └─ db - UPSERT cds.outbox.Messages
//                       └─ cds.spawn - schedule task
//
//   2. cds.spawn - run task                       (queue worker root)
//        ├─ db - tx                               (tx 1)
//        │    ├─ db - READ cds.outbox.Messages
//        │    └─ db - UPDATE cds.outbox.Messages
//        └─ messaging - tx                        (tx 2)
//             ├─ messaging - handle foo
//             └─ db - DELETE cds.outbox.Messages
//
//   3. messaging - tx                             (file-based CONSUMER)
//        └─ ...handler work (READ Books, READ Authors)...
//
// Plus the scheduling service may emit a bookkeeping `db - tx` (startup scan finding no
// tasks) — tolerated as a 4th root, not required.

const CHECK = ({ expect, rootSpans, groupedByTrace }) => {
  // Producer trace
  const producer = groupedByTrace.find(g => g.all.some(s => s.name === 'AdminService - handle test_emit'))
  expect(producer, 'expected a producer trace').to.exist
  expect(producer.root.name).to.equal('AdminService - tx')
  expect(producer.all.some(s => s.name === 'messaging - emit outgoing foo')).to.be.true
  expect(producer.all.some(s => s.name === 'db - UPSERT cds.outbox.Messages')).to.be.true
  expect(producer.all.some(s => s.name === 'cds.spawn - schedule task')).to.be.true

  // Queue worker trace: rooted at `cds.spawn - run task`, containing both tx spans as children.
  const workerTrace = groupedByTrace.find(g => g.root.name === 'cds.spawn - run task')
  expect(workerTrace, 'expected a queue-worker spawn-root trace').to.exist

  // tx 1: db - tx with READ + UPDATE of the outbox
  const workerDbTx = workerTrace.all.find(s => s.name === 'db - tx')
  expect(workerDbTx, 'expected a db - tx child in the worker trace (tx 1)').to.exist
  expect(workerTrace.all.some(s => s.name === 'db - READ cds.outbox.Messages')).to.be.true
  expect(workerTrace.all.some(s => s.name === 'db - UPDATE cds.outbox.Messages')).to.be.true

  // tx 2: messaging - tx with handle foo + DELETE of the outbox row
  const workerMessagingTx = workerTrace.all.find(s => s.name === 'messaging - tx')
  expect(workerMessagingTx, 'expected a messaging - tx child in the worker trace (tx 2)').to.exist
  expect(workerTrace.all.some(s => s.name === 'messaging - handle foo')).to.be.true
  expect(workerTrace.all.some(s => s.name === 'db - DELETE cds.outbox.Messages')).to.be.true

  // File-based CONSUMER trace (the file-messaging consumer, *not* the queue-worker path).
  // Identified by containing the full `foo` handler work (SELECT Books + READ Authors).
  const consumer = groupedByTrace.find(
    g =>
      g !== producer &&
      g !== workerTrace &&
      g.root.name === 'messaging - tx' &&
      g.all.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/)) &&
      g.all.some(s => s.name === 'AdminService - READ AdminService.Authors')
  )
  expect(consumer, 'expected a CONSUMER trace').to.exist
  expect(consumer.all.some(s => s.name === 'messaging - emit outgoing foo')).to.be.true
  expect(consumer.all.some(s => s.name === 'messaging - handle foo')).to.be.true

  // 3 meaningful roots; tolerate one extra for the scheduling-service bookkeeping scan
  // (a `db - tx` root with just a READ, no UPDATE).
  expect(rootSpans.length).to.be.gte(3)
  expect(rootSpans.length).to.be.lte(4)

  // Sanity: every non-root span has a parent inside the captured set.
  const allSpans = groupedByTrace.flatMap(g => g.all)
  for (const s of allSpans) {
    const pid = s.parentSpanContext?.spanId
    if (!pid) continue
    const parent = allSpans.find(p => p.spanContext().spanId === pid)
    expect(parent, `expected parent span for ${s.name}`).to.exist
  }
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
