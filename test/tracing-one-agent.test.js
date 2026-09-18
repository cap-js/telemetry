// When Dynatrace OneAgent is active (`via_one_agent`), OneAgent captures OpenTelemetry spans
// in-process — so instead of exporting traces ourselves (which would duplicate them), the tracing
// factory registers a real, recording tracer provider with an EMPTY span-processor list. That
// provider records spans (so the global tracer used by lib/tracing/trace.js is no longer a no-op)
// but adds no export path of our own; OneAgent's preload hooks observe the recorded spans.
//
// Two properties must hold and are asserted here without a live Dynatrace tenant:
//   1. crash-safety — an EMPTY processor list `[]` must not crash on the first span, unlike the
//      `[undefined]` a naive "no exporter -> no processor" path would have produced (which crashed
//      in MultiSpanProcessor.onStart);
//   2. the provider is real and RECORDING — a provider that doesn't record would leave CDS spans
//      non-existent, which is the regression this path must avoid.
//
// We drive the factory directly rather than through a full boot: exercising `via_one_agent` needs
// kind `*-to-dynatrace` (whose exporters would otherwise demand real Dynatrace credentials at boot).
// Booting once with the in-memory tracing profile populates `cds.env` and caches lib/tracing; the
// tests then flip `cds.env.requires.telemetry.kind` + the env flag and call the factory in isolation.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

const { resourceFromAttributes } = require('@opentelemetry/resources')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const { hasDependency } = require('../lib/utils/common')
const setupTracing = require('../lib/tracing')

describe('tracing setup with Dynatrace OneAgent', () => {
  const OTLP_PROTO = '@opentelemetry/exporter-trace-otlp-proto'

  // Guard on the illustrative failure mode: a provider whose only span processor is `undefined`
  // builds fine but crashes on the first span in onStart. It is the reason the OneAgent path passes
  // an empty list `[]` rather than `[processor]` with a missing processor.
  test('a provider with an undefined span processor crashes on the first span', () => {
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({}),
      spanProcessors: [undefined]
    })
    expect(() => provider.getTracer('probe').startSpan('boom')).toThrow(/onStart/)
  })

  // Precondition for `via_one_agent`: the otlp-proto exporter must NOT be a (production) dependency
  // — it is only a devDependency here, and hasDependency() checks `dependencies` only. With it
  // present, `via_one_agent` would be false and the normal OTLP export path taken instead.
  test('otlp-proto exporter is not a production dependency (so via_one_agent can be true)', () => {
    expect(hasDependency(OTLP_PROTO)).toBe(false)
  })

  describe('OneAgent path', () => {
    let savedKind, savedEnv

    beforeEach(() => {
      savedKind = cds.env.requires.telemetry.kind
      savedEnv = process.env.DT_NODE_PRELOAD_OPTIONS
      process.env.DT_NODE_PRELOAD_OPTIONS = '{}'
      cds.env.requires.telemetry.kind = 'telemetry-to-dynatrace'
    })

    afterEach(() => {
      cds.env.requires.telemetry.kind = savedKind
      if (savedEnv === undefined) delete process.env.DT_NODE_PRELOAD_OPTIONS
      else process.env.DT_NODE_PRELOAD_OPTIONS = savedEnv
    })

    test('standalone: registers a real, recording provider with no export path, and does not crash', () => {
      // A truthy resource is the standalone path (a falsy resource is the CALM path).
      let provider
      expect(() => {
        provider = setupTracing(resourceFromAttributes({}))
      }).not.toThrow()

      // A real provider is returned (not undefined as on the pre-fix regression) ...
      expect(provider).toBeInstanceOf(NodeTracerProvider)

      // ... and it records: a span created the way lib/tracing/trace.js creates them is a real,
      // recording span — not a NonRecordingSpan — so CDS spans actually come into existence for
      // OneAgent to capture. The empty processor list means creating and ending it never crashes.
      const span = provider.getTracer('@cap-js/telemetry').startSpan('cds-span')
      expect(span.constructor.name).not.toBe('NonRecordingSpan')
      expect(span.isRecording()).toBe(true)
      expect(() => span.end()).not.toThrow()
    })

    test('CALM: leaves the xotel-agent-ext-js-owned provider alone (returns nothing)', () => {
      // A falsy resource is the CALM path: @sap/xotel-agent-ext-js owns the provider, so the
      // factory must not register a competing one.
      expect(setupTracing(undefined)).toBeUndefined()
    })
  })
})
