const CASE = 'without-outbox'

// REVISIT: even with profile "without-outbox", messaging kind and file from package.json wins
process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`,
  outboxed: false
})

// REVISIT: check json exports
const CHECK = (log, expect) => {
  // 2: no outbox -> consumer gets new root context
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(2)
}

describe(`tracing messaging - ${CASE}`, () => {
  require('./tracing-messaging')(CASE, CHECK)
})
