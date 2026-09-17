// Regression test: when Dynatrace OneAgent is active (`via_one_agent`), the tracing factory must
// NOT build a tracer provider with an undefined span processor.
//
// 2.x constructs the provider via the OTel 2.0 constructor `new NodeTracerProvider({ spanProcessors })`.
// On the OneAgent path no exporter/processor is created, so `processor` stayed `undefined` and
// `[undefined]` was handed to the provider — MultiSpanProcessor.onStart then dereferenced undefined
// on the FIRST span and the app crashed on startup (CF exit 137, crash loop).
//
// The fix: on the OneAgent path the factory sets up nothing and returns — no exporter, no processor,
// no provider, nothing to crash on. It deliberately does not export traces here (export to Dynatrace
// goes via the OTLP exporter instead) and must not register or clobber a global tracer provider.
//
// We drive the factory directly rather than through a full boot: exercising `via_one_agent` needs
// kind `*-to-dynatrace` (whose metrics/tracing exporters would otherwise demand real Dynatrace
// credentials at boot). Booting once with the in-memory tracing profile populates `cds.env` and
// caches lib/tracing; the tests then flip `cds.env.requires.telemetry.kind` + the env flag and call
// the factory in isolation.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

const otel = require('@opentelemetry/api')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const { hasDependency } = require('../lib/utils/common')
const setupTracing = require('../lib/tracing')

describe('tracing setup with Dynatrace OneAgent', () => {
  const OTLP_PROTO = '@opentelemetry/exporter-trace-otlp-proto'

  test('a provider with an undefined span processor crashes on the first span', () => {
    // This is the failure mode the OneAgent path must avoid: a provider whose only span processor
    // is `undefined`. It builds fine, but the first span crashes in onStart.
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({}),
      spanProcessors: [undefined]
    })
    expect(() => provider.getTracer('probe').startSpan('boom')).toThrow(/onStart/)
  })

  test('OneAgent path: sets up nothing, returns, and never touches an undefined processor', () => {
    // Precondition for `via_one_agent`: the otlp-proto exporter must NOT be a (production) dependency
    // — it is only a devDependency here, and hasDependency() checks `dependencies` only.
    expect(hasDependency(OTLP_PROTO)).toBe(false)

    const proxy = otel.trace.getTracerProvider() // the process-global ProxyTracerProvider
    const originalDelegate = proxy.getDelegate()

    const savedKind = cds.env.requires.telemetry.kind
    const savedEnv = process.env.DT_NODE_PRELOAD_OPTIONS
    process.env.DT_NODE_PRELOAD_OPTIONS = '{}'
    cds.env.requires.telemetry.kind = 'telemetry-to-dynatrace'

    try {
      // Must not throw. We pass a resource so it is the standalone path (a falsy resource is the
      // CALM path).
      let returned
      expect(() => {
        returned = setupTracing(resourceFromAttributes({}))
      }).not.toThrow()

      // The factory returns nothing and registers no provider of its own — the global delegate is
      // left exactly as it was.
      expect(returned).toBeUndefined()
      expect(proxy.getDelegate()).toBe(originalDelegate)

      // And a span created via the global API (as lib/tracing/trace.js does for every CDS span)
      // does not crash — with no real provider registered it is simply a non-recording span.
      expect(() => otel.trace.getTracer('@cap-js/telemetry').startSpan('cds-span').end()).not.toThrow()
    } finally {
      cds.env.requires.telemetry.kind = savedKind
      if (savedEnv === undefined) delete process.env.DT_NODE_PRELOAD_OPTIONS
      else process.env.DT_NODE_PRELOAD_OPTIONS = savedEnv
    }
  })
})
