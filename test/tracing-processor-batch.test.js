// Tests that an explicit processor override activates BatchSpanProcessor.
//
// The `[tracing-batch-processor]` profile in test/bookshop/.cdsrc.json explicitly
// sets `telemetry.tracing.processor.kind = "BatchSpanProcessor"`, overriding the
// `[development]` profile default of SimpleSpanProcessor. This proves the explicit-
// override path: a single config knob flips the active processor in a dev-profile run.
//
// NOTE: a "true production profile" boot (NODE_ENV=production or --profile production)
// is not feasible in the test bookshop — the production profile requires @cap-js/hana
// which is not installed. The production default (BatchSpanProcessor, defined in
// package.json's base tracing config) is therefore covered via this explicit override
// rather than a genuine production boot.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory, tracing-batch-processor')
const otel = require('@opentelemetry/api')

// Same accessor as in tracing-processor-simple.test.js — see that file for rationale.
function activeProcessorName() {
  const provider = otel.trace.getTracerProvider()
  const delegate = provider.getDelegate?.() ?? provider
  return delegate._activeSpanProcessor?._spanProcessors?.[0]?.constructor?.name
}

describe('span processor selection — explicit BatchSpanProcessor override', () => {
  test('tracing-batch-processor profile activates BatchSpanProcessor', () => {
    // The [tracing-batch-processor] profile overrides the [development] default
    // (SimpleSpanProcessor) to BatchSpanProcessor — the same processor production uses,
    // proven here via explicit override in a dev-profile run.
    expect(activeProcessorName()).toBe('BatchSpanProcessor')
  })
})
