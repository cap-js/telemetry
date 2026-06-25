// REVISIT: remove with cds^11

const CASE = 'in-memory-outbox'

// REVISIT: even with profile "in-memory-outbox", messaging kind and file from package.json wins
process.env.cds_requires_messaging = JSON.stringify({
  kind: 'file-based-messaging',
  file: `../${CASE}`
})

const CHECK = (log, expect) => {
  // 2: no outbox -> consumer gets new root context
  // REVISIT: for some reason, the emit done in the on succeeded callback gets a new root context when running in jest
  expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(3) //> actually 2
}

describe(`tracing messaging - ${CASE}`, () => {
  if (require('@sap/cds').version.split('.')[0] == 10) return test.skip('no in-memory queue in cds^10', () => {})

  require('./tracing-messaging')(CASE, CHECK)
})
