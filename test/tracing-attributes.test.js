process.env.cds_requires_telemetry_tracing_exporter_module = '@opentelemetry/sdk-trace-node'

const cds = require('@sap/cds')
const { expect, data } = cds.test().in(__dirname + '/bookshop')

describe('tracing attributes', () => {
  beforeEach(data.reset)

  const log = jest.spyOn(console, 'dir')
  beforeEach(log.mockClear)

  describe('db', () => {
    const _db_spans = require('./_db_spans')
    // prettier-ignore
    const _get_db_spans = o => JSON.parse(o).map(o => o[0]).filter(s => !s.name.startsWith('db'))
    const _match_db_spans = (output, kind) => {
      const db_spans = _get_db_spans(output)
      for (const each of _db_spans[kind]) expect(db_spans).to.containSubset([each])
    }

    test('SELECT', async () => {
      await SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
      _match_db_spans(output, 'SELECT')
    })

    test('INSERT', async () => {
      await INSERT.into('sap.capire.bookshop.Books').entries([{ ID: 1 }, { ID: 2 }])
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":2/)
      // TODO
      // _match_db_spans(output, 'INSERT')
    })

    test('UPDATE', async () => {
      await UPDATE('sap.capire.bookshop.Books').set({ stock: 42 }).where('ID > 250')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":3/)
      // TODO
      // _match_db_spans(output, 'UPDATE')
    })

    test('DELETE', async () => {
      await DELETE.from('sap.capire.bookshop.Books')
      const output = JSON.stringify(log.mock.calls)
      expect(output).to.match(/db\.client\.response.returned_rows":0/) //> texts
      expect(output).to.match(/db\.client\.response.returned_rows":5/)
      // TODO
      // _match_db_spans(output, 'DELETE')
    })
  })
})
