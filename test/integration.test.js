const cds = require('@sap/cds')
const bookshop = require('path').resolve(__dirname, './bookshop')

describe('Integration tests cds with open telemetry', () => {
  const { expect, GET, POST } = cds.test().in(bookshop)
  const admin = {
    auth: {
      username: 'alice'
    }
  }
  test('GET request is traced', async () => {
    const { status } = await GET('/admin/Genres', admin)
    expect(status).to.equal(200)
    // expect console to have trace logs
  })

  test.skip('cds.spawn is traced', async () => {})

  test('srv.emit is traced', async () => {
    const { status } = await POST('/browse/submitOrder', { book: 1, quantity: 1 }, admin)
    expect(status).to.equal(200)
    // Wait and afterwards check if trace of emit is part of exporter
  })

  test('$batch is traced', async () => {
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
    const { status } = await POST('/admin/$batch', batchBody, {
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
