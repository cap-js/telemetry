const CASE = 'outboxed-and-inboxed'

// Explicit `outboxed: true` + `inboxed: true`. Same lifecycle as the `inboxed` test — two
// queue workers, each running tx-1 (lock) and tx-2 (handle + delete). Setting outboxed
// explicitly is a no-op relative to the messaging default, so the observed shape matches
// the `inboxed` test:
//
//   1. AdminService - tx                    (producer)
//   2. cds.spawn - run task                  (outbox worker: dispatches to file)
//        ├─ db - tx        (tx 1)
//        └─ messaging - tx (tx 2: handle foo — writes to file — + DELETE)
//   3. messaging - tx                        (file-based CONSUMER: writes inbox row)
//        └─ ...enqueue into inbox...
//   4. cds.spawn - run task                  (inbox worker: runs subscriber)
//        ├─ db - tx        (tx 1)
//        └─ messaging - tx (tx 2: handle foo — full app work — + DELETE)
//
// 4 meaningful roots (+1 tolerated bookkeeping scan).

process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`,
  outboxed: true,
  inboxed: true
})

const CHECK = ({ expect, rootSpans, groupedByTrace }) => {
  // Producer trace
  const producer = groupedByTrace.find(g => g.all.some(s => s.name === 'AdminService - handle test_emit'))
  expect(producer, 'expected a producer trace').to.exist
  expect(producer.root.name).to.equal('AdminService - tx')
  expect(producer.all.some(s => s.name === 'db - UPSERT cds.outbox.Messages')).to.be.true

  const allSpans = groupedByTrace.flatMap(g => g.all)
  expect(allSpans.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/))).to.be.true
  expect(allSpans.some(s => s.name === 'db - DELETE cds.outbox.Messages')).to.be.true

  // Exactly two `cds.spawn - run task` roots (outbox + inbox workers).
  const workerRoots = rootSpans.filter(s => s.name === 'cds.spawn - run task')
  expect(workerRoots, 'expected two queue-worker spawn roots (outbox + inbox)').to.have.lengthOf(2)

  // The inbox worker ran the app handler.
  const inboxWorker = groupedByTrace.find(
    g => g.root.name === 'cds.spawn - run task' && g.all.some(s => s.name.match(/READ sap\.capire\.bookshop\.Books/))
  )
  expect(inboxWorker, 'expected an inbox-worker trace that ran the application handler').to.exist

  // 4 meaningful roots (+1 tolerated bookkeeping scan).
  expect(rootSpans.length).to.be.gte(4)
  expect(rootSpans.length).to.be.lte(5)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
