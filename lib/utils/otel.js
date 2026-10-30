const { getNumberFromEnv } = require('@opentelemetry/core')

// The unified tracing SDK takes explicit options, not OTEL_* environment defaults.
function getSpanLimits() {
  return {
    attributeCountLimit:
      getNumberFromEnv('OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT') ?? getNumberFromEnv('OTEL_ATTRIBUTE_COUNT_LIMIT'),
    attributeValueLengthLimit:
      getNumberFromEnv('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT') ??
      getNumberFromEnv('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'),
    eventCountLimit: getNumberFromEnv('OTEL_SPAN_EVENT_COUNT_LIMIT'),
    linkCountLimit: getNumberFromEnv('OTEL_SPAN_LINK_COUNT_LIMIT'),
    attributePerEventCountLimit: getNumberFromEnv('OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT'),
    attributePerLinkCountLimit: getNumberFromEnv('OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT')
  }
}

function getBatchSpanProcessorConfig(options) {
  const config = { ...options }
  for (const [key, env] of [
    ['maxExportBatchSize', 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE'],
    ['maxQueueSize', 'OTEL_BSP_MAX_QUEUE_SIZE'],
    ['scheduledDelayMillis', 'OTEL_BSP_SCHEDULE_DELAY'],
    ['exportTimeoutMillis', 'OTEL_BSP_EXPORT_TIMEOUT']
  ]) {
    if (config[key] === undefined) config[key] = getNumberFromEnv(env)
  }
  return config
}

module.exports = { getSpanLimits, getBatchSpanProcessorConfig }
