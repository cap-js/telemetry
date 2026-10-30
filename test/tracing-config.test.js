const cds = require('@sap/cds')
cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const setupTracing = require('../lib/tracing')
const { resourceFromAttributes } = require('@opentelemetry/resources')

describe('tracing configuration', () => {
  let provider, savedTracing, savedEnv
  const variables = [
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

  beforeEach(() => {
    savedTracing = cds.env.requires.telemetry.tracing
    savedEnv = Object.fromEntries(variables.map(variable => [variable, process.env[variable]]))
    for (const variable of variables) delete process.env[variable]
  })

  afterEach(async () => {
    await provider?.shutdown()
    provider = undefined
    cds.env.requires.telemetry.tracing = savedTracing
    for (const [variable, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[variable]
      else process.env[variable] = value
    }
  })

  function createProvider(processor = { kind: 'SimpleSpanProcessor' }) {
    cds.env.requires.telemetry.tracing = { ...savedTracing, processor }
    provider = setupTracing(resourceFromAttributes({}))
    return provider.getTracer('configuration')
  }

  test('general attribute limits remain the fallback for spans', () => {
    process.env.OTEL_ATTRIBUTE_COUNT_LIMIT = '1'
    process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '3'
    const span = createProvider().startSpan('limited', { attributes: { first: 'abcdef', second: 'ghijkl' } })
    expect(span.attributes).toEqual({ first: 'abc' })
    span.end()
  })

  test('span-specific limits take precedence and limit events and links', () => {
    process.env.OTEL_ATTRIBUTE_COUNT_LIMIT = '1'
    process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '1'
    process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = '2'
    process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = '3'
    process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_LINK_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT = '1'
    process.env.OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT = '1'
    const context = { traceId: '11111111111111111111111111111111', spanId: '1111111111111111', traceFlags: 1 }
    const link = { context, attributes: { first: 'a', second: 'b' } }
    const span = createProvider().startSpan('limited', {
      attributes: { first: 'abcdef', second: 'ghijkl', third: 'mnopqr' },
      links: [link, link]
    })
    span.addEvent('old', { first: 'a', second: 'b' })
    span.addEvent('new', { first: 'c', second: 'd' })
    expect(span.attributes).toEqual({ first: 'abc', second: 'ghi' })
    expect(span.events).toEqual([expect.objectContaining({ name: 'new', attributes: { first: 'c' } })])
    expect(span.links).toEqual([expect.objectContaining({ attributes: { first: 'a' } })])
    span.end()
  })

  test('batch options override environment defaults without overriding the configured exporter', async () => {
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = '8'
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '2'
    process.env.OTEL_BSP_SCHEDULE_DELAY = '1234'
    process.env.OTEL_BSP_EXPORT_TIMEOUT = '5678'
    const tracer = createProvider({ kind: 'BatchSpanProcessor', config: { maxQueueSize: 4, exporter: undefined } })
    const processor = provider._activeSpanProcessor._spanProcessors[0]
    expect(processor._maxQueueSize).toBe(4)
    expect(processor._maxExportBatchSize).toBe(2)
    expect(processor._scheduledDelayMillis).toBe(1234)
    expect(processor._exportTimeoutMillis).toBe(5678)
    expect(processor._exporter).toBeDefined()
    tracer.startSpan('flushable').end()
    await expect(provider.forceFlush()).resolves.toBeUndefined()
  })
})
