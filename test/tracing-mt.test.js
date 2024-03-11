const cds = require('@sap/cds')
const { expect, GET } = cds.test('serve', '--in-memory', '--project', __dirname + '/bookshop', '--profile', 'multitenancy')
const log = cds.test.log()

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

  beforeEach(log.clear)

  test('GET with user1 is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', user1)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry|tenant_1\] - elapsed times:/)
    expect(log.output).to.match(/\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* AdminService - READ AdminService.Books/)
  })

  test('GET with user2 is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', user2)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry|tenant_2\] - elapsed times:/)
    expect(log.output).to.match(/\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* AdminService - READ AdminService.Books/)
  })

  // --- TODO ---

  test.skip('$batch is traced', async () => {})

  test.skip('individual handlers are traced', async () => {})

  test.skip('srv.emit is traced', async () => {})

  test.skip('cds.spawn is traced', async () => {})

  test.skip('remote is traced', async () => {})
})
