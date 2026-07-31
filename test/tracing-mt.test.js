const cds = require('@sap/cds')
// prettier-ignore
const { expect, GET } = cds.test('serve', '--in-memory', '--project', __dirname + '/bookshop', '--profile', 'multitenancy,tracing-in-memory')

const { reset, captured } = require('./bookshop/lib/MyInMemorySpanExporter')

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
    // AdminService READ ran and was tagged with the right tenant.
    const span = captured.find(s => s.name === 'AdminService - READ AdminService.Books')
    expect(span, 'expected AdminService READ span').to.exist
    expect(span.attributes['sap.tenancy.tenant_id']).to.equal(TENANT1)
  })

  test('GET with user2 is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', user2)
    expect(status).to.equal(200)
    const span = captured.find(s => s.name === 'AdminService - READ AdminService.Books')
    expect(span, 'expected AdminService READ span').to.exist
    expect(span.attributes['sap.tenancy.tenant_id']).to.equal(TENANT2)
  })

  // --- TODO ---

  test.skip('$batch is traced', async () => {})

  test.skip('individual handlers are traced', async () => {})

  test.skip('srv.emit is traced', async () => {})

  test.skip('cds.spawn is traced', async () => {})

  test.skip('remote is traced', async () => {})
})
