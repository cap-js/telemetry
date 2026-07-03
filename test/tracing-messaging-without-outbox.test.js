const CASE = 'without-outbox'

// REVISIT: even with profile "without-outbox", messaging kind and file from package.json wins
process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`,
  outboxed: false
})

// Without outbox, file-based messaging writes directly to the file from the producer's
// transaction (no queue worker). The file watcher delivers asynchronously as a new
// SpanKind.CONSUMER root.
//
// Expected roots:
//   1. AdminService - tx                    (producer)
//        └─ AdminService - handle test_emit
//             └─ messaging - emit outgoing foo
//                  └─ messaging - handle foo  (writes to file, in-process)
//
//   2. messaging - tx                       (file-based CONSUMER)
//        └─ messaging - emit outgoing foo
//             └─ messaging - handle foo
//                  └─ ...handler work...
//
// The scheduling service may also emit a bookkeeping scan trace (`db - tx → db - READ
// cds.outbox.Messages` finding nothing) — we allow it but don't require it.

const CHECK = ({ expect, rootSpans, groupedByTrace }) => {
  // Producer trace
  const producer = groupedByTrace.find(g => g.all.some(s => s.name === 'AdminService - handle test_emit'))
  expect(producer, 'expected a producer trace').to.exist
  expect(producer.root.name).to.equal('AdminService - tx')
  expect(producer.all.some(s => s.name.match(/messaging - emit outgoing/))).to.be.true

  // File-based CONSUMER trace
  const consumer = groupedByTrace.find(
    g => g !== producer && g.root.name === 'messaging - tx' && g.all.some(s => s.name === 'messaging - handle foo')
  )
  expect(consumer, 'expected a CONSUMER trace').to.exist
  expect(consumer.all.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/))).to.be.true

  // 2 meaningful roots; allow up to 3 to tolerate the scheduling service's bookkeeping scan.
  expect(rootSpans.length).to.be.gte(2)
  expect(rootSpans.length).to.be.lte(3)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
