const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

const sleep = require('util').promisify(setTimeout)

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
    // 4: POST: create/ new + read after write, GET: read actives + read drafts
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(4)
  })

  test('cds.spawn is traced', async () => {
    await POST('/odata/v4/admin/spawn', {}, admin)
    await sleep(30)
    // 2: action + spawned action
    expect(log.output.match(/\[telemetry\] - elapsed times:/g).length).to.equal(2)
  })
  
  describe('db', () => {
    describe('ql', () => {
      test('SELECT is traced', async () => {
        await SELECT.from('sap.capire.bookshop.Books')
        // primitive check that console has trace logs
        expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
        expect(log.output).to.match(
          /\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* db - READ sap\.capire\.bookshop\.Books/
        )
      })
    })

    test('native db statement is traced', async () => {
      const db = await cds.connect.to('db')
      await db.run('SELECT ID, title, stock, price FROM AdminService_Books WHERE ID = 201 OR ID = 207')
      // primitive check that console has trace logs
      expect(log.output).to.match(/\[telemetry\] - elapsed times:/)
      expect(log.output).to.match(
        /\s+\d+\.\d+ → \s*\d+\.\d+ = \s*\d+\.\d+ ms \s* db - SELECT .* FROM AdminService_Books WHERE ID = 201 OR I…/
      )
    })
  })

  // --- TODO ---

  test.skip('individual handlers are traced', async () => {})

  test.skip('srv.emit is traced', async () => {})

  test.skip('remote is traced', async () => {})
})
