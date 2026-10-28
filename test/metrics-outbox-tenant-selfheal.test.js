const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

// Regression for #545: the per-tenant queue-stats poller must not keep polling a tenant whose
// database is gone.
//
// queue.js spawns a RECURRING cds.spawn job (privileged_context.every = exportIntervalMillis / 2)
// the first time a message is enqueued for a (tenant, service). There is no unsubscribe signal in
// the main application under a separate MTX sidecar, so the poller is self-healing: when a poll
// fails with a 404 (the tenant's database has been deprovisioned) it stops itself and drops the
// tenant's metrics; any other (transient) error is ignored, because cds.spawn keeps the interval
// running and the poll recovers on its own.
//
// cds.spawn surfaces each run's outcome as 'succeeded'/'failed'/'done' events on the returned
// EventEmitter, with the original error forwarded intact. This test drives those events directly:
// sqlite never 404s, so a real deprovisioning can't be reproduced here — instead a synthetic
// 'failed' is emitted on the captured poller to exercise queue.js's own error handling.

const { expect, GET, axios } = cds.test(
  __dirname + '/bookshop',
  '--with-mocks',
  '--profile',
  'metrics-outbox, multitenancy'
)
axios.defaults.validateStatus = () => true

// Multitenancy runs on sqlite only; excluded from the HANA job (needs a bound Service Manager).
// See TESTING.md → Sanctioned skips and vitest.config.mjs.
describe('queue metrics poller self-heals when a tenant is gone', () => {
  // tenant_1 is one of the mocked users' tenants (test/bookshop/package.json → auth.users); using a
  // configured tenant means the GET below runs in its context and deploys/uses its own outbox table.
  const T = 'tenant_1'
  const user = { auth: { username: `user_${T}` } }

  // Recurring jobs (those spawned with `every`) captured from cds.spawn, keyed by tenant. `runs`
  // counts completed iterations via the 'done' event, which cds.spawn emits in a `.finally` after
  // every run — successful OR failed. `job` is the emitter itself, so the test can inject a
  // synthetic poll outcome via `job.emit('failed', err)`.
  const recurringJobs = []
  let originalSpawn

  beforeAll(async () => {
    const proxyService = await cds.connect.to('ProxyService')
    const externalServiceOne = await cds.connect.to('ExternalServiceOne')
    const externalServiceOneQ = cds.outboxed(externalServiceOne)

    proxyService.on('proxyCallToExternalServiceOne', async req => {
      await externalServiceOneQ.send('call', {})
      return req.reply('OK')
    })
    externalServiceOne.on('call', req => req.reply('OK'))

    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(T)
  })

  afterAll(() => {
    if (originalSpawn) cds.spawn = originalSpawn
  })

  test('stops on a 404 (tenant deprovisioned) but keeps running through a transient error', async () => {
    // Spy on cds.spawn to capture the recurring per-tenant poller. Installed here (not in beforeAll)
    // so it stays clear of the tenant subscribe/deploy above — only the poller, spawned on enqueue
    // below, is of interest. A recurring job is one spawned with `every`.
    originalSpawn = cds.spawn
    cds.spawn = function (...args) {
      const job = originalSpawn.apply(this, args)
      const ctx = args[0]
      if (ctx && typeof ctx === 'object' && ctx.every) {
        const rec = { tenant: ctx.tenant, runs: 0, job }
        job.on('done', () => rec.runs++)
        recurringJobs.push(rec)
      }
      return job
    }

    // Enqueue a message in T's outbox — this is what spawns the recurring per-tenant stats poller.
    const { status } = await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user)
    expect(status).to.equal(200)

    const pollMs = cds.env.requires.telemetry.metrics.config.exportIntervalMillis / 2

    // Wait until the poller exists and has fired at least once, so we know it is genuinely live.
    const jobFor = () => recurringJobs.find(j => j.tenant === T)
    const deadline = Date.now() + 5000
    while (!(jobFor()?.runs >= 1) && Date.now() < deadline) await wait(Math.min(pollMs, 50))
    const rec = jobFor()
    expect(rec, 'enqueuing a message should spawn a recurring per-tenant queue-stats poller').to.exist
    expect(rec.runs, 'the poller should be firing before the injected errors').to.be.gte(1)

    // A transient error (a plain Error, no `status`) must NOT stop the poller: cds.spawn keeps the
    // interval alive, so the next tick recovers. Assert it keeps firing afterwards.
    const runsBeforeTransient = rec.runs
    rec.job.emit('failed', new Error(`Pool exceeded for '${T}' within 1000ms`))
    await wait(pollMs * 2)
    expect(
      rec.runs,
      'a transient poll error must not stop the poller (it recovers on the next tick)'
    ).to.be.greaterThan(runsBeforeTransient)

    // A 404 means the tenant's database is deprovisioned — the poller must stop itself and the
    // tenant's metrics must be dropped. (In production this error originates from the Service
    // Manager via the DB pool; sqlite can't produce it, so it is injected here.)
    rec.job.emit('failed', Object.assign(new Error(`Tenant '${T}' does not exist`), { status: 404 }))

    // Clearing the interval can't cancel a real tick already in flight; let it settle, then assert
    // the run count is stable over several intervals — i.e. no further polls happen.
    await wait(pollMs)
    const runsAfterStop = rec.runs
    await wait(pollMs * 3)
    expect(rec.runs, 'the poller must stop firing once the tenant is gone (404) — #545').to.equal(runsAfterStop)
  })
})
