const cds = require('@sap/cds')
// Companion to tracing-hana-statement-cache.test.js, with the statement cache DISABLED via
// `cds.requires.db.hana_statements_cache: false` (the [hana-no-stmt-cache] profile). It proves
// db.query.text stays correct on the non-cached path too: with caching off, @cap-js/hana >= 3.1
// re-prepares on every execution, so a repeated query is a cache MISS — a `@cap-js/hana - prepare`
// span is produced on the re-run and the SQL text rides it as before. The paired test (cache on)
// covers the cache-HIT path where no prepare runs; together they lock in both.
// NOTE: currently skipped on HANA — the opt-out is broken upstream (cap-js/cds-dbs#1761). See #528.
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory,hana-no-stmt-cache')

const { captured, reset } = require('./bookshop/lib/MyInMemorySpanExporter')

describe('db.query.text with the HANA statement cache disabled', () => {
  // HANA-only, same signal as the cache-on test: the kill switch and prepared statements are a
  // HANA driver feature; sqlite re-prepares anyway and has no cache to disable. Branch on
  // TELEMETRY_TEST_HANA, not cds.env (reading cds.env at collection time freezes the exporter
  // before cds.test() applies the in-memory profile — see TESTING.md "How the HANA path is signalled").
  if (!process.env.TELEMETRY_TEST_HANA) {
    test.skip('n/a without HANA (no prepared-statement cache to disable on sqlite)', () => {})
    return
  }

  const capSpans = () => captured.filter(s => s.instrumentationScope?.name === '@cap-js/telemetry')

  // Skipped on HANA: the cache-OFF path depends on @cap-js/hana's `hana_statements_cache: false`
  // opt-out, which is broken upstream — every query throws "stmt.release is not a function"
  // (fix: cap-js/cds-dbs#1761). The test body below is correct and ready to run once a fixed
  // @cap-js/hana is released; unskip is tracked by #528. Flip `test.skip` back to `test` then.
  test.skip('re-run re-prepares and still carries db.query.text', async () => {
    // Runtime read of cds.db.kind is safe (unlike cds.env at collection time) and guards against a
    // misconfigured run silently passing on sqlite.
    expect(cds.db.kind, 'this test is only meaningful on HANA').to.equal('hana')
    expect(
      cds.env.requires.db.hana_statements_cache,
      'the [hana-no-stmt-cache] profile must disable the statement cache'
    ).to.equal(false)

    const q = () => SELECT.from('sap.capire.bookshop.Books').where('title !=', 'DUMMY')

    await cds.db.tx(async tx => {
      await tx.run(q()) // first run
      reset() // drop the first run's spans so we only assert on the re-run
      await tx.run(q()) // cache disabled -> re-prepares (cache MISS), unlike the cache-on test
    })

    // The differentiator from the cache-on case: a prepare span reappears for the re-run, proving
    // caching really is off, and it carries the SQL.
    const prepareSpan = capSpans().find(s => /@cap-js\/hana - prepare/.test(s.name))
    expect(prepareSpan, 're-run should re-prepare when the cache is disabled').to.exist
    expect(prepareSpan.attributes['db.query.text'], 'prepare span must carry SQL').to.match(/SELECT/)

    // And the SQL still propagates to the CAP-level `db - READ` span, as it must regardless of caching.
    const readSpan = capSpans().find(s => s.name === 'db - READ sap.capire.bookshop.Books')
    expect(readSpan, 'db - READ span should exist for the re-run').to.exist
    expect(readSpan.attributes['db.query.text'], 're-run must carry SQL').to.match(/SELECT/)
  })
})
