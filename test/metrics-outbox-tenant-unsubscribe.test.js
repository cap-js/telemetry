const cds = require('@sap/cds')
const { setTimeout: wait } = require('node:timers/promises')

// Reproduction for #545: the per-tenant queue-stats poller is never cleared on tenant unsubscribe.
//
// queue.js spawns a RECURRING cds.spawn job (privileged_context.every = exportIntervalMillis / 2)
// the first time a message is enqueued for a (tenant, service). In production, when that tenant is
// later unsubscribed (its HANA container deprovisioned), nothing stops the job — it keeps polling
// the now-gone tenant forever, logging "Pool failed connecting to '<tenant>' / Tenant does not
// exist" every ~exportIntervalMillis/2 until the process restarts.
//
// This test spies on cds.spawn to capture that recurring job, unsubscribes the tenant, and asserts
// the job stops firing afterwards. With the bug present the job keeps running, so it FAILS; a fix
// that clears the interval on `DeploymentService.after('unsubscribe')` makes it pass.

const { expect, GET, axios } = cds.test(
  __dirname + '/bookshop',
  '--with-mocks',
  '--profile',
  'metrics-outbox, multitenancy'
)
axios.defaults.validateStatus = () => true

// Multitenancy runs on sqlite only; excluded from the HANA job (needs a bound Service Manager).
// See TESTING.md → Sanctioned skips.
describe('queue metrics clean up a tenant on unsubscribe', () => {
  // tenant_1 is one of the mocked users' tenants (test/bookshop/package.json → auth.users); using a
  // configured tenant means the GET below runs in its context and deploys/uses its own outbox table.
  const T = 'tenant_1'
  const user = { auth: { username: `user_${T}` } }

  // Recurring jobs (those spawned with `every`) captured from cds.spawn, keyed by tenant. `runs`
  // counts completed iterations via the 'done' event, which cds.spawn emits in a `.finally` after
  // every run — successful OR failed — so a poll that throws against the dead tenant still counts.
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

  test('the per-tenant queue-stats poller stops when the tenant is unsubscribed', async () => {
    const mts = await cds.connect.to('cds.xt.DeploymentService')

    // Spy on cds.spawn to capture the recurring per-tenant poller. Installed here (not in beforeAll)
    // so it stays clear of the tenant subscribe/deploy above — only the poller, spawned on enqueue
    // below, is of interest. A recurring job is one spawned with `every`; cds.spawn returns an
    // EventEmitter that fires 'done' in a `.finally` after every iteration (success or failure).
    originalSpawn = cds.spawn
    cds.spawn = function (...args) {
      const job = originalSpawn.apply(this, args)
      const ctx = args[0]
      if (ctx && typeof ctx === 'object' && ctx.every) {
        const rec = { tenant: ctx.tenant, runs: 0, failures: 0 }
        job.on('done', () => rec.runs++)
        job.on('failed', () => rec.failures++)
        recurringJobs.push(rec)
      }
      return job
    }

    // Enqueue a message in T's outbox — this is what spawns the recurring per-tenant stats poller.
    const { status } = await GET('/odata/v4/proxy/proxyCallToExternalServiceOne', user)
    expect(status).to.equal(200)

    const pollMs = cds.env.requires.telemetry.metrics.config.exportIntervalMillis / 2

    // Wait until the poller exists and has fired at least once, so we know it is genuinely live
    // before we unsubscribe (otherwise a frozen `runs` could be a false pass).
    const jobFor = () => recurringJobs.find(j => j.tenant === T)
    const deadline = Date.now() + 5000
    while (!(jobFor()?.runs >= 1) && Date.now() < deadline) await wait(Math.min(pollMs, 50))
    const job = jobFor()
    expect(job, 'enqueuing a message should spawn a recurring per-tenant queue-stats poller').to.exist
    expect(job.runs, 'the poller should be firing before unsubscribe').to.be.gte(1)

    // Unsubscribe the tenant — in production this deprovisions its HANA container.
    await mts.unsubscribe(T)

    // Give the poller several intervals to fire again. A correctly cleaned-up poller does nothing
    // here; the leaking one keeps polling the deprovisioned tenant.
    const runsAtUnsubscribe = job.runs
    await wait(pollMs * 3)

    expect(
      job.runs,
      'the per-tenant queue-stats poller must stop firing once the tenant is unsubscribed (#545)'
    ).to.equal(runsAtUnsubscribe)
  })
})
