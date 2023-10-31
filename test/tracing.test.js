const cds = require('@sap/cds')
const { expect, GET, POST } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

describe('Integration tests cds with open telemetry', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(() => {
    log.clear()
  })

  test('GET request is traced', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    // primitive check that console has trace logs
    expect(log.output).to.match(/\[otel\] - \s+\d+\.\d+ ms/)
  })

  // --- HERE ---

  test.skip('cds.spawn is traced', async () => {})

  test.skip('srv.emit is traced', async () => {
    const { status } = await POST('/browse/submitOrder', { book: 1, quantity: 1 }, admin)
    expect(status).to.equal(200)
    // Wait and afterwards check if trace of emit is part of exporter
  })

  test.skip('$batch is traced', async () => {
    const CRLF = '\r\n'
    const batchBody = [
      '--batch_1',
      'Content-Type: application/http',
      'content-transfer-encoding: binary',
      '',
      'GET /Genres/$count HTTP/1.1',
      '',
      '',
      '--batch_1',
      'Content-Type: application/http',
      'content-transfer-encoding: binary',
      '',
      'GET /Genres?$skip=0&$top=20&$orderby=ID%20desc HTTP/1.1',
      '',
      '',
      '--batch_1--',
      ''
    ].join(CRLF)
    const { status } = await POST('/odata/v4/admin/$batch', batchBody, {
      auth: admin.auth,
      headers: {
        'content-type': 'multipart/mixed;boundary=batch_1',
        accept: 'multipart/mixed'
      }
    })
    expect(status).to.equal(200)
  })

  test.skip('Handler are by default not traced', async () => {})

  test.skip('Handler are traced when logging component app = trace', async () => {})

  test.skip('middlewares are by default not traced', async () => {})

  test.skip('middelwares are traced when enabled', async () => {})
})
