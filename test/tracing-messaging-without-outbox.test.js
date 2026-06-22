const CASE = 'without_outbox'

const env = {
  kind: 'file-based-messaging',
  outbox: false,
  file: `../${CASE}`
}
process.env.cds_requires_messaging = JSON.stringify(env)

const CHECK = (log, expect) => {
  // 3: no outbox -> consumer gets new root context + HTTP span
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(3)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
