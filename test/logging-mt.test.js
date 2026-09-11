/* eslint-disable no-console */

// REVISIT: even with profile "logging", cls_custom_fields from package.json wins
process.env.cds_log = JSON.stringify({ cls_custom_fields: ['foo'] })

const cds = require('@sap/cds')
// prettier-ignore
const { expect, GET } = cds.test('serve', '--in-memory', '--project', __dirname + '/bookshop', '--profile', 'logging,multitenancy')

describe('logging with multitenancy', () => {
  const TENANT1 = 'tenant_1'
  const TENANT2 = 'tenant_2'
  const user1 = { auth: { username: `user_${TENANT1}` } }
  const user2 = { auth: { username: `user_${TENANT2}` } }

  const { dir } = console
  beforeAll(async () => {
    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(TENANT1)
    await mts.subscribe(TENANT2)
  })
  beforeEach(() => {
    console.dir = jest.fn()
  })
  afterAll(() => {
    console.dir = dir
  })

  test('log records carry the tenant id for tenant_1', async () => {
    const { status } = await GET('/odata/v4/admin/Genres', user1)
    expect(status).to.equal(200)
    const logs = console.dir.mock.calls.map(([log]) => log)
    // the request-scoped logs from the AdminService READ Genres handler
    const scoped = logs.filter(l => l?.attributes?.['sap.tenancy.tenant_id'])
    expect(scoped.length).to.be.greaterThan(0)
    for (const log of scoped) {
      expect(log.attributes['sap.tenancy.tenant_id']).to.equal(TENANT1)
      expect(log.attributes['sap.cds.correlation_id']).to.be.a('string')
    }
  })

  test('log records carry the tenant id for tenant_2', async () => {
    const { status } = await GET('/odata/v4/admin/Genres', user2)
    expect(status).to.equal(200)
    const logs = console.dir.mock.calls.map(([log]) => log)
    const scoped = logs.filter(l => l?.attributes?.['sap.tenancy.tenant_id'])
    expect(scoped.length).to.be.greaterThan(0)
    for (const log of scoped) {
      expect(log.attributes['sap.tenancy.tenant_id']).to.equal(TENANT2)
    }
  })
})
