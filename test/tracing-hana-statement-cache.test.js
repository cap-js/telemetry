const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

// Regression test: db.query.text must survive a cached HANA prepared statement.
//
// @cap-js/hana >= 3.1 caches prepared statements per connection. A repeated parameterized
// query is therefore a cache HIT: no `prepare` step runs, so no `@cap-js/hana - prepare`
// span is produced — and the SQL text used to ride only on that prepare span. The result
// was that the re-run's `db - READ …` span (and its inner `@cap-js/hana - exec` span) lost
// their `db.query.text`, which downstream performance tooling relies on.
//
// SQLite has no such statement cache (every execution re-prepares), so the lost-SQL case
// can only occur on HANA — skip elsewhere.
const { captured, reset } = require('./bookshop/lib/MyInMemorySpanExporter')

describe('db.query.text survives a cached HANA prepared statement', () => {
  if (cds.env.requires.db.kind === 'sqlite') {
    test.skip('n/a for SQLite (no prepared-statement cache)', () => {})
    return
  }

  const capSpans = () => captured.filter(s => s.instrumentationScope?.name === '@cap-js/telemetry')

  test('cached re-run still carries db.query.text', async () => {
    const q = () => SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')

    // Both runs share ONE pooled connection (single tx), so the 2nd run is a cache hit.
    await cds.db.tx(async tx => {
      await tx.run(q()) // cache miss: prepare + exec spans, SQL present
      reset() // drop the first run's spans so we only assert on the cached re-run
      await tx.run(q()) // cache hit: no prepare span
    })

    // The CAP-level `db - READ` span is emitted regardless of the _hana_prom setting, and is
    // the span observed to go empty on a cache hit. After the fix it carries the SQL again
    // (surfaced from the cached statement's _sql via the exec span).
    const readSpan = capSpans().find(s => s.name === 'db - READ sap.capire.bookshop.Books')
    expect(readSpan, 'db - READ span should exist for the re-run').to.exist
    expect(readSpan.attributes['db.query.text'], 'cached re-run must still carry SQL').to.match(/SELECT/)

    // And the native exec span itself (the _hana_prom path where the loss originated).
    const execSpan = capSpans().find(s => /@cap-js\/hana - exec/.test(s.name))
    if (execSpan) {
      expect(execSpan.attributes['db.query.text'], 'cached exec span must still carry SQL').to.match(/SELECT/)
    }
  })
})
