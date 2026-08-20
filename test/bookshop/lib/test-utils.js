// Shared test helpers, centralized here so the ~10 tracing/metrics suites stop copy-pasting them.
//
// Kept dependency-light on purpose: it does NOT `require('@sap/cds')` at module top (doing so once
// broke span capture for the sibling span exporter — the cds require has to happen inside the test
// file, after the profile is applied). Only @opentelemetry primitives + node timers here.
//
// `clearOutbox` uses the global `DELETE` (the cds query API). That global is installed by cds.test()
// in the test process, and clearOutbox is only ever called from within hooks/tests (after setup), so
// the global is reliably present at call time — the module never needs to require @sap/cds itself.

const otel = require('@opentelemetry/api')
const { suppressTracing } = require('@opentelemetry/core')
const { setTimeout: wait } = require('node:timers/promises')

// The test's HTTP client runs in-process and, with outgoing HTTP instrumentation now enabled, would
// itself create a CLIENT span for every request — an artificial extra root that also overwrites any
// manually-set `traceparent` header. Real callers are separate, un-instrumented processes, so we run
// client-side requests under suppressTracing to model that: the outgoing CLIENT span is skipped and
// the incoming SERVER span is created normally by the server handler.
const asExternalClient = fn => otel.context.with(suppressTracing(otel.context.active()), fn)

// Best-effort outbox clear that can NEVER hang the surrounding hook. On the shared HANA HDI
// container a background queue worker may be holding the connection pool (draining/retrying), so a
// bare `DELETE` can block indefinitely — which previously turned into a hook timeout that starved
// the pool and cascaded into ECONNREFUSED for the NEXT test file's server. Race the DELETE against a
// short timeout and swallow errors: if it can't complete quickly, the leftover rows are handled by
// the next file's own beforeEach clear anyway.
async function clearOutbox(timeout = 5000) {
  try {
    await Promise.race([DELETE.from('cds.outbox.Messages'), wait(timeout)])
  } catch {
    // pool draining / server shutting down — nothing left to clean matters
  }
}

// Force-flush the tracer provider's span processor so any spans buffered by background activity are
// exported into `captured`. The global provider is a ProxyTracerProvider (no forceFlush) whose
// delegate is the real NodeTracerProvider; guard for the no-op provider so a misconfigured profile
// fails loudly, not silently.
async function flushSpans() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush()
}

// State-based wait: repeatedly flush + re-run the assertion until it holds or times out. Replaces
// the fixed `wait(...)` sleeps that flake on HANA, where background/spawned work flushes its data
// after any reasonable fixed window.
//
// `flush` is the target to force before each re-check. It defaults to `flushSpans` (the span
// callers). Metric callers pass the meter provider's `forceFlush` (exported by MyInMemoryMetricReader)
// — passing it keeps this module from depending on the reader. Defaults (timeout 15000, interval 50)
// match the span call sites; metric call sites pass their own timeout/interval explicitly.
async function eventually(fn, { flush = flushSpans, timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  let lastError
  while (true) {
    await flush()
    try {
      await fn()
      return
    } catch (err) {
      lastError = err
      if (Date.now() - start >= timeout) throw lastError
      await wait(interval)
    }
  }
}

// Build an `expectEventually(assertion)` bound to a specific flush target + poll defaults, so the
// metric suites don't each re-declare the same one-line wrapper. Metric callers pass the meter
// provider's `forceFlush` and their own {timeout, interval} (which vary per suite); the returned
// helper takes just the assertion. Equivalent to `a => eventually(a, { flush, timeout, interval })`.
const makeExpectEventually = (flush, { timeout, interval } = {}) => assertion =>
  eventually(assertion, { flush, timeout, interval })

// On HANA the persistent-outbox queue scheduler periodically scans `cds.outbox.Messages` in its own
// `db - tx` (a SELECT + optional UPDATE that finds nothing to dispatch). Those land as extra root
// traces unrelated to the emit under test — and because the single HDI container is shared across all
// test files, scans triggered by other files' lingering workers show up too. Filter those pure
// outbox-scan traces so the exact root-count assertions stay stable. A scan trace is a `db - tx` root
// whose every span only touches `cds.outbox.Messages` (no application entity, no messaging/handle span).
const isOutboxScanTrace = g =>
  g.root.name === 'db - tx' && g.all.every(s => s.name === 'db - tx' || s.name.includes('cds.outbox.Messages'))

// Drop the outbox-scan bookkeeping traces from a `groupedByTrace()` array, returning the meaningful groups.
const meaningful = groups => groups.filter(g => !isOutboxScanTrace(g))

module.exports = {
  asExternalClient,
  clearOutbox,
  flushSpans,
  eventually,
  makeExpectEventually,
  isOutboxScanTrace,
  meaningful
}
