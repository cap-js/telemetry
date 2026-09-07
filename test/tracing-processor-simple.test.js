// Tests that the development profile selects SimpleSpanProcessor.
//
// Per package.json `cds.requires.kinds.telemetry.tracing`, the package-level default
// (production) processor is BatchSpanProcessor; the `[development]` profile in
// package.json overrides it to SimpleSpanProcessor. In the test environment
// (NODE_ENV != production) the `[development]` profile applies automatically, so a
// plain boot should yield SimpleSpanProcessor without any additional override.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const otel = require('@opentelemetry/api')

// Reach the active span processor installed by the tracing factory.
//
// The global OTel provider is a ProxyTracerProvider (returned by trace.getTracerProvider());
// getDelegate() unwraps it to the real NodeTracerProvider built by lib/tracing/index.js.
// NodeTracerProvider wraps all registered processors in a private MultiSpanProcessor
// accessible as _activeSpanProcessor. We drill one level deeper to _spanProcessors[0]
// (the single processor the factory installed) to read its constructor name.
// _spanProcessors is a private `_`-prefixed field, but it is the only stable path to the
// live processor instance; `flushSpans()` in test/utils.js follows the same
// getDelegate() + forceFlush() pattern for the same reason.
function activeProcessorName() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  return delegate._activeSpanProcessor?._spanProcessors?.[0]?.constructor?.name
}

describe('span processor selection — development profile', () => {
  test('development profile activates SimpleSpanProcessor', () => {
    // [development] is auto-applied in non-production (NODE_ENV=test) environments.
    // The plugin should have wired a SimpleSpanProcessor (not the batch default).
    expect(activeProcessorName()).toBe('SimpleSpanProcessor')
  })
})
