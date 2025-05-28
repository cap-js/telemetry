const CASE = 'with_outbox'

const env = {
  kind: 'file-based-messaging',
  outbox: true,
  file: `../${CASE}`
}
process.env.cds_requires_messaging = JSON.stringify(env)

const CHECK = (log, expect) => {
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
