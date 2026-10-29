const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

// Regression for #545: the per-tenant queue-stats poller must stop itself when a tenant's database
// is gone, yet keep running through a transient error. sqlite can't produce a real 404, so the test
// captures the spawned poller and drives its 'failed' outcomes directly.

const { expect, GET, axios } = cds.test(
  __dirname + '/bookshop',
  '--with-mocks',
  '--profile',
  'metrics-outbox, multitenancy'
)
axios.defaults.validateStatus = () => true

// Multitenancy runs on sqlite only; excluded from the HANA job (needs a bound Service Manager).
describe('queue metrics poller self-heals when a tenant is gone', () => {
  const T = 'tenant_1' // a configured mock tenant (bookshop auth.users); the GET runs in its context
  const user = { auth: { username: `user_${T}` } }

  // `runs` counts completed iterations ('done' fires after every run); `job` is the emitter, so the
  // test can inject a poll outcome via `job.emit('failed', err)`.
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
    // Spy after setup so only the enqueue-spawned poller is captured (a recurring job has `every`).
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

    // Enqueuing a message is what spawns the recurring per-tenant poller.
    const { status } = await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user)
    expect(status).to.equal(200)

    const pollMs = cds.env.requires.telemetry.metrics.config.exportIntervalMillis / 2

    // Wait until the poller has fired at least once, so a frozen `runs` can't be a false pass.
    const jobFor = () => recurringJobs.find(j => j.tenant === T)
    const deadline = Date.now() + 5000
    while (!(jobFor()?.runs >= 1) && Date.now() < deadline) await wait(Math.min(pollMs, 50))
    const rec = jobFor()
    expect(rec, 'enqueuing a message should spawn a recurring per-tenant queue-stats poller').to.exist
    expect(rec.runs, 'the poller should be firing before the injected errors').to.be.gte(1)

    // Transient error (no `status`): the poller must keep firing.
    const runsBeforeTransient = rec.runs
    rec.job.emit('failed', new Error(`Pool exceeded for '${T}' within 1000ms`))
    await wait(pollMs * 2)
    expect(
      rec.runs,
      'a transient poll error must not stop the poller (it recovers on the next tick)'
    ).to.be.greaterThan(runsBeforeTransient)

    // 404: tenant deprovisioned — the poller must stop. Injected, since sqlite can't produce it.
    rec.job.emit('failed', Object.assign(new Error(`Tenant '${T}' does not exist`), { status: 404 }))

    // Let an in-flight tick settle, then assert `runs` stays stable — no further polls.
    await wait(pollMs)
    const runsAfterStop = rec.runs
    await wait(pollMs * 3)
    expect(rec.runs, 'the poller must stop firing once the tenant is gone (404) — #545').to.equal(runsAfterStop)
  })
})
