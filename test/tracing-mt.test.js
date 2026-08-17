const cds = require('@sap/cds')
// prettier-ignore
const { expect, GET } = cds.test('serve', '--in-memory', '--project', __dirname + '/bookshop', '--profile', 'multitenancy,tracing-in-memory')

const { reset, captured } = require('./bookshop/lib/MyInMemorySpanExporter')

// Multitenancy needs a bound BTP Service Manager (MTX) to provision per-tenant HDI containers.
// The HANA CI runs against a single pre-provisioned HDI container with no Service Manager, so this
// suite is excluded from the HANA job in vitest.config.mjs. It runs on sqlite (in-memory tenants).
describe('tracing with multitenancy', () => {
  const TENANT1 = 'tenant_1'
  const TENANT2 = 'tenant_2'
  const USER1 = `user_${TENANT1}`
  const USER2 = `user_${TENANT2}`
  const user1 = { auth: { username: USER1 } }
  const user2 = { auth: { username: USER2 } }

  beforeAll(async () => {
    const mts = await cds.connect.to('cds.xt.DeploymentService')
    await mts.subscribe(TENANT1)
    await mts.subscribe(TENANT2)
  })

  beforeEach(reset)

  test('GET with user1 is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', user1)
    expect(status).to.equal(200)
    // AdminService READ ran exactly once and was tagged with the right tenant.
    const spans = captured.filter(s => s.name === 'AdminService - READ AdminService.Books')
    expect(spans.length, 'expected exactly one AdminService READ span').to.equal(1)
    expect(spans[0].attributes['sap.tenancy.tenant_id']).to.equal(TENANT1)
  })

  test('GET with user2 is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', user2)
    expect(status).to.equal(200)
    const spans = captured.filter(s => s.name === 'AdminService - READ AdminService.Books')
    expect(spans.length, 'expected exactly one AdminService READ span').to.equal(1)
    expect(spans[0].attributes['sap.tenancy.tenant_id']).to.equal(TENANT2)
  })

  // --- TODO ---

  test.skip('$batch is traced', async () => {})

  test.skip('individual handlers are traced', async () => {})

  test.skip('srv.emit is traced', async () => {})

  test.skip('cds.spawn is traced', async () => {})

  test.skip('remote is traced', async () => {})
})
