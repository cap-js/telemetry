const cds = require('@sap/cds')
const DIR = __dirname + '/bookshop-mt'
cds.test.in(DIR)

const TENANT1 = 'tenant_1'
const TENANT2 = 'tenant_2'
const USER1 = `user_${TENANT1}`
const USER2 = `user_${TENANT2}`

const user1 = { auth: { username: USER1 } }
const user2 = { auth: { username: USER2 } }

describe('Integration tests cds with open telemetry', () => {
  const { expect, GET, POST } = cds.test(DIR)
  const log = cds.test.log()

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

  test('NonRecordingSpans are handled correctly', async () => {
    const { status: postStatus } = await POST('/odata/v4/admin/Authors', { ID: 42, name: 'Douglas Adams' }, user1)
    expect(postStatus).to.equal(201)
    const { status: getStatus } = await GET('/odata/v4/admin/Authors?$select=ID', user1)
    expect(getStatus).to.equal(200)
    // primitive check that console has no trace logs
    expect(log.output).not.to.match(/telemetry/)
  })
})
