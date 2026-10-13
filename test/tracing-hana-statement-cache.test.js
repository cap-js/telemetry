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
  // HANA-only: sqlite has no prepared-statement cache, so there's nothing to reproduce.
  // Branch on the TELEMETRY_TEST_HANA signal, NOT cds.env — reading cds.env at collection
  // time freezes the env singleton before cds.test() applies the in-memory exporter profile,
  // so no spans would be captured (see TESTING.md "How the HANA path is signalled").
  if (!process.env.TELEMETRY_TEST_HANA) {
    test.skip('n/a without HANA (no prepared-statement cache on sqlite)', () => {})
    return
  }

  const capSpans = () => captured.filter(s => s.instrumentationScope?.name === '@cap-js/telemetry')

  test('cached re-run still carries db.query.text', async () => {
    // Guard against a misconfigured run silently passing on sqlite (no statement cache).
    // Runtime read of cds.db.kind is safe — unlike reading cds.env at collection time.
    expect(cds.db.kind, 'this test is only meaningful on HANA').to.equal('hana')

    const q = () => SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')

    // Both runs share ONE pooled connection (single tx), so the 2nd run is a cache hit.
    await cds.db.tx(async tx => {
      await tx.run(q()) // cache miss: prepare + exec spans, SQL present
      reset() // drop the first run's spans so we only assert on the cached re-run
      await tx.run(q()) // cache hit: no prepare span
    })

    // A `prepare` span proves the cache hit only on the prom leg: _hana_prom=true wraps the native
    // prom('prepare') (runs on a cache miss only), so its ABSENCE proves the hit; _hana_prom=false
    // wraps SQLService#prepare (runs per execution), so a prepare span always reappears with the SQL.
    const { _hana_prom } = cds.env.requires.telemetry.tracing
    const prepareSpan = capSpans().find(s => /@cap-js\/hana - prepare/.test(s.name))
    if (_hana_prom) {
      expect(prepareSpan, 're-run must be a native cache hit (no prepare span)').to.not.exist
    } else {
      expect(prepareSpan, 'SQLService#prepare is wrapped per execution on the non-prom leg').to.exist
      expect(prepareSpan.attributes['db.query.text'], 'prepare span must carry SQL').to.match(/SELECT/)
    }

    // The CAP-level `db - READ` span is emitted on BOTH legs and is the span that went empty on a
    // cache hit — the cross-cutting guarantee. With the fix in place it carries the SQL again.
    const readSpan = capSpans().find(s => s.name === 'db - READ sap.capire.bookshop.Books')
    expect(readSpan, 'db - READ span should exist for the re-run').to.exist
    expect(readSpan.attributes['db.query.text'], 'cached re-run must still carry SQL').to.match(/SELECT/)

    // The native exec span — where the SQL was lost — is only wrapped on the _hana_prom leg.
    const execSpan = capSpans().find(s => /@cap-js\/hana - exec/.test(s.name))
    if (_hana_prom) {
      expect(execSpan, 'exec span must exist on the _hana_prom path').to.exist
      expect(execSpan.attributes['db.query.text'], 'cached exec span must still carry SQL').to.match(/SELECT/)
    }
  })
})
