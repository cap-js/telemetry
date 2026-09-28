// In-memory metric reader for tests. Exported metrics are accumulated in a module-level array
// that tests can import directly via `require('./lib/MyInMemoryMetricReader').captured`.
// Wired into the meter provider via .cdsrc.json profile config (no provider-poking from tests):
// the class is exporter-shaped (has `export()`), so lib/metrics/index.js wraps it in a
// PeriodicExportingMetricReader — keeping the configured `exportIntervalMillis` working.
//
// Kept dependency-light on purpose: it does NOT `require('@sap/cds')` at module top (doing so
// broke span capture once for the sibling span exporter). Only @opentelemetry primitives.
//
// TEMPORALITY: mirrors production. lib/metrics/index.js configures the real exporter with
// `temporalityPreference: AggregationTemporality.DELTA`, so the tests must validate what a real
// DELTA export produces — the reader honors that preference rather than forcing CUMULATIVE.
//
// Under DELTA each export reports only the *increment* since the previous collection, and
// `expectEventually` force-flushes repeatedly, so a naive "latest datapoint" read of a counter
// would drop to 0 after the first flush. We therefore split handling by datapoint type:
//   * SUM datapoints (the 3 counters: incoming_messages, outgoing_messages, processing_failures)
//     are summed into a running total per counter series (metric name + full attribute set) —
//     reconstructing the cumulative value the tests assert against (totalInc/totalOut/totalFailed).
//   * GAUGE datapoints (cold_entries, remaining_entries, *_storage_time_in_seconds) are absolute
//     point-in-time observations; for those we keep the latest exported value, never a sum.

const { ExportResultCode } = require('@opentelemetry/core')
const { AggregationTemporality, DataPointType } = require('@opentelemetry/sdk-metrics')
const { metrics } = require('@opentelemetry/api')

// Raw ResourceMetrics objects, one per collection/flush. Drives the GAUGE latest-value lookup.
const captured = []

// Running totals for SUM (counter) series. Keyed by the fully-qualified series identity
// (metric name + every attribute on the datapoint) so distinct (queue.name, tenant) series never
// collide; each entry keeps the original attributes so lookups can match by attribute subset the
// same way the gauge path does. Under DELTA the SDK reports the increment since its last
// collection; summing every increment a series receives reconstructs its cumulative value — which
// is what the tests track (totalInc/totalOut/totalFailed grow monotonically, never reset per case).
//
// NOTE: `captured` and `counterSeries` are process-level singletons. Cross-file correctness relies
// on Vitest isolating each test file in its own worker process (vitest.config.mjs: pool:'forks' +
// isolate:true). Two files sharing this module in one process would bleed counter totals together.
const counterSeries = new Map()

function seriesKey(metricName, attributes) {
  const sorted = Object.keys(attributes)
    .sort()
    .map(k => `${k}=${attributes[k]}`)
    .join('&')
  return `${metricName} ${sorted}`
}

// True when `sub` is an attribute subset of `full` (all keys present with equal values).
function attributesMatch(full, sub) {
  return Object.entries(sub).every(([key, value]) => full[key] === value)
}

class MyInMemoryMetricReader {
  constructor(config = {}) {
    // Honor the temporality the plugin config sets (DELTA in production) so the tests exercise the
    // real export shape. Defaults to DELTA to match lib/metrics/index.js when no config is passed.
    this._temporality = config.temporalityPreference ?? AggregationTemporality.DELTA
  }

  // Invoked by PeriodicExportingMetricReader for each instrument type.
  selectAggregationTemporality() {
    return this._temporality
  }

  export(resourceMetrics, resultCallback) {
    captured.push(resourceMetrics)

    // Fold DELTA increments of SUM (counter) datapoints into the running totals.
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.dataPointType !== DataPointType.SUM) continue
        for (const dp of metric.dataPoints) {
          const key = seriesKey(metric.descriptor.name, dp.attributes)
          const entry = counterSeries.get(key)
          if (entry) entry.total += dp.value
          else counterSeries.set(key, { name: metric.descriptor.name, attributes: dp.attributes, total: dp.value })
        }
      }
    }

    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown() {
    return Promise.resolve()
  }

  forceFlush() {
    return Promise.resolve()
  }
}

// Most recent GAUGE MetricData for `queue.<metricName>` that carries datapoints, scanning captured
// exports newest-first (mirrors the old `consoleDirLogs.findLast(... && dataPoints?.length)`).
function latestGaugeMetric(metricName) {
  const name = `queue.${metricName}`
  for (let i = captured.length - 1; i >= 0; i--) {
    for (const scopeMetrics of captured[i].scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (
          metric.descriptor.name === name &&
          metric.dataPointType === DataPointType.GAUGE &&
          metric.dataPoints?.length
        )
          return metric
      }
    }
  }
  return null
}

// Accumulated counter total for `queue.<metricName>` across all series whose attributes match the
// given filter (subset match, like the gauge lookup). Returns null when no counter series exists
// for that name — i.e. the metric was never exported as a counter (queue metrics disabled) or the
// filter matches nothing.
function counterTotal(metricName, attributes) {
  const name = `queue.${metricName}`
  let found = false
  let total = 0
  for (const entry of counterSeries.values()) {
    if (entry.name === name && attributesMatch(entry.attributes, attributes)) {
      found = true
      total += entry.total
    }
  }
  return found ? total : null
}

// Names of metrics that are SUM (counter) instruments — the three counters the queue plugin
// registers. Dispatches latestDataPointValue explicitly, rather than relying on counterSeries
// happening to be populated (which is empty on the first poll after reset()).
const COUNTER_METRIC_NAMES = new Set([
  'queue.incoming_messages',
  'queue.outgoing_messages',
  'queue.processing_failures'
])

function isCounter(metricName) {
  return COUNTER_METRIC_NAMES.has(`queue.${metricName}`)
}

// Value of `queue.<metricName>` for the datapoint(s) matching all given attributes
// (e.g. { 'queue.name': ... } and/or { 'sap.tenancy.tenant_id': ... }). For counters this is the
// accumulated running total (cumulative, reconstructed from DELTA increments); for gauges it is
// the latest absolute observation. Returns null when the metric was never exported (queue metrics
// disabled) or no datapoint matches the filter.
function latestDataPointValue(metricName, attributes = {}) {
  if (isCounter(metricName)) return counterTotal(metricName, attributes)

  const metric = latestGaugeMetric(metricName)
  if (!metric) return null
  const dp = metric.dataPoints.find(dp => attributesMatch(dp.attributes, attributes))
  return dp ? dp.value : null
}

// Force the wired meter provider to collect + export now, so the reader reflects the latest state.
// Fails fast if the provider isn't the real (wired) one — a NoopMeterProvider has no forceFlush,
// which would otherwise silently no-op and let a polling helper busy-spin its whole timeout.
async function forceFlush() {
  const provider = metrics.getMeterProvider()
  if (typeof provider.forceFlush !== 'function') {
    throw new Error(
      'MyInMemoryMetricReader.forceFlush: meter provider is not wired up (no forceFlush) — ' +
        'is the metrics-outbox profile active and the reader configured?'
    )
  }
  await provider.forceFlush()
}

// Clears the per-test GAUGE state (captured exports) so a stale point-in-time value from a previous
// case cannot leak. The counter running totals are intentionally NOT cleared: the suites' counter
// assertions (totalInc/totalOut/totalFailed) and the plugin's underlying counters are cumulative
// across the whole file, and the SDK's DELTA baseline likewise persists across flushes — zeroing
// only our side would desync it and under-count. See the module header for the full rationale.
function reset() {
  captured.length = 0
}

module.exports = {
  MyInMemoryMetricReader,
  captured,
  counterSeries,
  latestGaugeMetric,
  latestDataPointValue,
  forceFlush,
  reset
}
