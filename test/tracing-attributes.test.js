process.env.cds_requires_telemetry_tracing_exporter_module = '@opentelemetry/sdk-trace-node'

const cds = require('@sap/cds')
const { expect, data } = cds.test().in(__dirname + '/bookshop')

describe('tracing attributes', () => {
  beforeEach(data.reset)

  const log = jest.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  describe('db.client.response.returned_rows', () => {
    test('SELECT', async () => {
      await SELECT.from('sap.capire.bookshop.Books')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
    })

    test('INSERT', async () => {
      await INSERT.into('sap.capire.bookshop.Books').entries([{ ID: 1 }, { ID: 2 }])
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":2/)
    })

    test('UPDATE', async () => {
      await UPDATE('sap.capire.bookshop.Books').set({ stock: 42 }).where('ID > 250')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":3/)
    })

    test('DELETE', async () => {
      await DELETE.from('sap.capire.bookshop.Books')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":0/) //> texts
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
    })
  })
})
