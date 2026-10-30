const cds = require('@sap/cds')
cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

const { TracerProvider } = require('@opentelemetry/sdk-trace')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const api = require('@opentelemetry/api')
const { SDK_INFO } = require('@opentelemetry/core')
const setupTracing = require('../lib/tracing')

describe('OpenTelemetry SDK 3', () => {
  let tracing, provider
  const env = [
    'OTEL_ATTRIBUTE_COUNT_LIMIT',
    'OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT',
    'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT',
    'OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT',
    'OTEL_SPAN_EVENT_COUNT_LIMIT',
    'OTEL_SPAN_LINK_COUNT_LIMIT',
    'OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT',
    'OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT',
    'OTEL_BSP_MAX_QUEUE_SIZE',
    'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
    'OTEL_BSP_SCHEDULE_DELAY',
    'OTEL_BSP_EXPORT_TIMEOUT'
  ]
  let savedEnv

  beforeEach(() => {
    tracing = cds.env.requires.telemetry.tracing
    savedEnv = Object.fromEntries(env.map(name => [name, process.env[name]]))
    for (const name of env) delete process.env[name]
  })

  afterEach(async () => {
    await provider?.shutdown()
    provider = undefined
    cds.env.requires.telemetry.tracing = tracing
    for (const name of env) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
  })

  function setup(processor = { kind: 'SimpleSpanProcessor' }) {
    cds.env.requires.telemetry.tracing = { ...tracing, processor }
    return (provider = setupTracing(resourceFromAttributes({})))
  }

  test('uses SDK 3 with its integrated logging API', () => {
    const major = Number(SDK_INFO['telemetry.sdk.version'].split('.')[0])
    expect(major).toBe(3)
    expect(api.logs.getLoggerProvider).toBeTypeOf('function')
    expect(api.SeverityNumber.INFO).toBe(9)
  })

  test('uses the unified tracer provider', () => {
    expect(setup()).toBeInstanceOf(TracerProvider)
    expect(provider.constructor.name).toBe('TracerProvider')
    const span = provider.getTracer('compat').startSpan('recording')
    expect(span.isRecording()).toBe(true)
    span.end()
  })

  test('preserves general attribute limits and span-specific precedence', () => {
    process.env.OTEL_ATTRIBUTE_COUNT_LIMIT = '1'
    process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '2'
    process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = '2'
    process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = '3'
    const span = setup()
      .getTracer('compat')
      .startSpan('limited', { attributes: { a: 'abcd', b: 'efgh', c: 'ijkl' } })
    expect(span.attributes).toEqual({ a: 'abc', b: 'efg' })
    span.end()
  })

  test('falls back to general attribute limits', () => {
    process.env.OTEL_ATTRIBUTE_COUNT_LIMIT = '1'
    process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '2'
    const span = setup()
      .getTracer('compat')
      .startSpan('limited', { attributes: { a: 'abcd', b: 'efgh' } })
    expect(span.attributes).toEqual({ a: 'ab' })
    span.end()
  })

  test('preserves event and link limits', () => {
    process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_LINK_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT = '1'
    const context = { traceId: '12345678901234567890123456789012', spanId: '1234567890123456', traceFlags: 1 }
    const link = { context, attributes: { a: 1, b: 2 } }
    const span = setup()
      .getTracer('compat')
      .startSpan('limited', { links: [link, link] })
    span.addEvent('first', { a: 1, b: 2 })
    span.addEvent('second', { c: 3, d: 4 })
    expect(span.links).toHaveLength(1)
    expect(span.links[0].attributes).toEqual({ a: 1 })
    expect(span.events).toHaveLength(1)
    expect(span.events[0]).toMatchObject({ name: 'second', attributes: { c: 3 } })
    span.end()
  })

  test('batch configuration overrides environment defaults and preserves the exporter', async () => {
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = '2'
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '1'
    process.env.OTEL_BSP_SCHEDULE_DELAY = '1234'
    process.env.OTEL_BSP_EXPORT_TIMEOUT = '5678'
    setup({ kind: 'BatchSpanProcessor', config: { maxQueueSize: 3, exporter: undefined } })
    const processor = provider._activeSpanProcessor._spanProcessors[0]
    expect(processor._maxQueueSize).toBe(3)
    expect(processor._maxExportBatchSize).toBe(1)
    expect(processor._scheduledDelayMillis).toBe(1234)
    expect(processor._exportTimeoutMillis).toBe(5678)
    expect(processor._exporter).toBeDefined()
    provider.getTracer('compat').startSpan('exported').end()
    await expect(provider.forceFlush()).resolves.toBeUndefined()
  })
})
