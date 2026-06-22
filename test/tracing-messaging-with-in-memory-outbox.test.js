const CASE = 'with_in_memory_outbox'

const env = {
  kind: 'file-based-messaging',
  outbox: { kind: 'in-memory-outbox' },
  file: `../${CASE}`
}
process.env.cds_requires_messaging = JSON.stringify(env)

const CHECK = (log, expect) => {
  // 3: in-memory-outbox -> emit in on-succeeded callback gets new root context
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(3)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
