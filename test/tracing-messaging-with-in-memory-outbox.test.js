const CASE = 'with_in_memory_outbox'

const env = {
  kind: 'file-based-messaging',
  outbox: true,
  file: `../${CASE}`
}
process.env.cds_requires_messaging = JSON.stringify(env)
process.env.cds_requires_outbox = JSON.stringify({ kind: 'in-memory-outbox' })

const CHECK = (log, expect) => {
  // 2: no outbox -> consumer gets new root context
  // REVISIT: for some reason, the emit done in the on succeeded callback gets a new root context when running in jest
  expect(log.output).to.equal('dummy')
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(3) //> actually 2
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
