// Regression test for #502: when Dynatrace OneAgent is active (`via_one_agent`), the tracing
// factory must NOT build its own tracer provider with an undefined span processor.
//
// Background: 2.x rewrote the factory to always construct a NodeTracerProvider via the OTel 2.0
// constructor `new NodeTracerProvider({ spanProcessors: [processor] })`. On the OneAgent path no
// exporter/processor is created, so `processor` stayed `undefined` and `[undefined]` was handed to
// the provider — MultiSpanProcessor.onStart then dereferenced undefined on the FIRST span and the
// app crashed on startup (CF exit 137, crash loop).
//
// The fix restores the 1.6.0 behavior (Option A): on the OneAgent path we do not build/register our
// own provider at all. OneAgent has already registered the global TracerProvider, and our spans
// obtain their tracer via the global OpenTelemetry API (see lib/tracing/trace.js), so they flow into
// OneAgent's provider. The factory returns nothing and never touches an undefined processor;
// registerInstrumentations() then falls back to the live global proxy, which delegates to OneAgent.
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
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')

const { hasDependency } = require('../lib/utils')
const setupTracing = require('../lib/tracing')

describe('tracing setup with Dynatrace OneAgent (#502)', () => {
  const OTLP_PROTO = '@opentelemetry/exporter-trace-otlp-proto'

  test('the pre-fix code path — an undefined span processor — crashes on the first span', () => {
    // This is exactly what the 2.x factory did on the OneAgent path: build a provider whose only
    // span processor is `undefined`. It builds fine, but the first span crashes in onStart.
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({}),
      spanProcessors: [undefined]
    })
    expect(() => provider.getTracer('probe').startSpan('boom')).toThrow(/onStart/)
  })

  test('OneAgent path: reuse the global provider, register nothing, route spans into it', async () => {
    // Precondition for `via_one_agent`: the otlp-proto exporter must NOT be a (production) dependency
    // — it is only a devDependency here, and hasDependency() checks `dependencies` only.
    expect(hasDependency(OTLP_PROTO)).toBe(false)

    const proxy = otel.trace.getTracerProvider() // the process-global ProxyTracerProvider
    const originalDelegate = proxy.getDelegate()

    // Simulate Dynatrace OneAgent having registered the global TracerProvider before us.
    const captured = new InMemorySpanExporter()
    const oneAgentProvider = new NodeTracerProvider({
      resource: resourceFromAttributes({}),
      spanProcessors: [new SimpleSpanProcessor(captured)]
    })
    proxy.setDelegate(oneAgentProvider)

    const savedKind = cds.env.requires.telemetry.kind
    const savedEnv = process.env.DT_NODE_PRELOAD_OPTIONS
    process.env.DT_NODE_PRELOAD_OPTIONS = '{}'
    cds.env.requires.telemetry.kind = 'telemetry-to-dynatrace'

    try {
      // Must not throw (pre-fix this returned a provider that crashed on the first span). We pass a
      // resource so it is the standalone path (a falsy resource is the CALM path).
      let returned
      expect(() => {
        returned = setupTracing(resourceFromAttributes({}))
      }).not.toThrow()

      // Option A: the factory registers no provider of its own — it returns nothing and leaves
      // OneAgent's provider as the global delegate untouched. (registerInstrumentations() in
      // lib/index.js then falls back to the live global proxy, which delegates to OneAgent.)
      expect(returned).toBeUndefined()
      expect(proxy.getDelegate()).toBe(oneAgentProvider)

      // A span created via the global API (as lib/tracing/trace.js does for every CDS span) must
      // flow into OneAgent's provider — and, crucially, not crash.
      expect(() => otel.trace.getTracer('@cap-js/telemetry').startSpan('cds-span').end()).not.toThrow()
      await oneAgentProvider.forceFlush()
      expect(captured.getFinishedSpans().map(s => s.name)).toContain('cds-span')
    } finally {
      proxy.setDelegate(originalDelegate)
      cds.env.requires.telemetry.kind = savedKind
      if (savedEnv === undefined) delete process.env.DT_NODE_PRELOAD_OPTIONS
      else process.env.DT_NODE_PRELOAD_OPTIONS = savedEnv
    }
  })
})
