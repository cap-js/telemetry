const CASE = 'with_persistent-outbox'

const env = {
  kind: 'file-based-messaging',
  outbox: true,
  file: `../${CASE}`
}
process.env.cds_requires_messaging = JSON.stringify(env)
process.env.cds_requires_outbox = JSON.stringify({ kind: 'persistent-outbox' })

process.env.cds_requires_telemetry_metrics = null

const CHECK = (log, expect) => {
  // 3: outbox -> consumers get new root context
  // REVISIT: for some reason, span "cds.spawn run task" has no parent when running in jest
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4) //> actually 3
  expect(log.output.match(/cds.spawn - schedule task/g).length).to.equal(1)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
