const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

describe('tracing', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(log.clear)

  test('GET is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
    expect(log.output).to.match(/\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* AdminService - READ AdminService.Books/)
  })

  test('NonRecordingSpans are handled correctly', async () => {
    const { status: postStatus } = await POST('/odata/v4/admin/Authors', { ID: 42, name: 'Douglas Adams' }, admin)
    expect(postStatus).to.equal(201)
    const { status: getStatus } = await GET('/odata/v4/admin/Authors?$select=ID', admin)
    expect(getStatus).to.equal(200)
    // primitive check that console has no trace logs
    expect(log.output).not.to.match(/telemetry/)
  })

  test('$batch is traced', async () => {
    await POST(
      '/odata/v4/genre/$batch',
      {
        requests: [
          { id: 'r1', method: 'POST', url: '/Genres', headers: { 'content-type': 'application/json' }, body: {} },
          { id: 'r2', method: 'GET', url: '/Genres', headers: {} }
        ]
      },
      admin
    )
    // 4: create/ new, read after write, read actives, read drafts
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4)
  })

  // --- TODO ---

  test.skip('individual handlers are traced', async () => {})

  test.skip('srv.emit is traced', async () => {})

  test.skip('cds.spawn is traced', async () => {})

  test.skip('remote is traced', async () => {})
})
