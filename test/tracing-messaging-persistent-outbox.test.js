const CASE = 'persistent-outbox'

// REVISIT: even with profile "in-memory-outbox", messaging kind and file from package.json wins
process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`
})

const CHECK = (log, expect) => {
  // 3: outbox -> consumers get new root context
  // REVISIT: for some reason, span "cds.spawn run task" has no parent when running in jest
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4) //> actually 3
  expect(log.output.match(/cds.spawn - schedule task/g).length).to.equal(1)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
