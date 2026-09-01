// Unit tests for ConsoleMetricExporter — verifies the user-friendly formatting of the three
// output branches (db.pool table, queue table, "other" metrics) plus the aggregated host-metrics
// block, by feeding the exporter crafted ResourceMetrics-shaped fixtures and inspecting the
// formatted strings passed to LOG.info.
//
// This is a pure unit test: no cds.test server, no real OTel SDK, no console spying.

const cds = require('@sap/cds')

// Hook LOG.info BEFORE requiring the exporter so the exporter's module-level
// `cds.log('telemetry')` resolves to a logger whose .info we control.
const infoCalls = []
const telemetryLog = cds.log('telemetry')
const originalInfo = telemetryLog.info
telemetryLog.info = (...args) => infoCalls.push(args)

const ConsoleMetricExporter = require('../lib/exporter/ConsoleMetricExporter')

afterAll(() => {
  telemetryLog.info = originalInfo
})

beforeEach(() => {
  infoCalls.length = 0
})

// --- helpers ---------------------------------------------------------------

// Builds a minimal ScopeMetrics-shaped object.
function scopeMetrics(name, metrics) {
  return { scope: { name }, metrics }
}

// Builds a minimal MetricData-shaped object. `dataPoints` are `{ attributes, value }`.
function metric(name, dataPoints, description = name) {
  return { descriptor: { name, description }, dataPoints }
}

// Drives the exporter and returns the lines logged. Asserts the result callback got SUCCESS.
function exportAndCapture(scopes) {
  const exporter = new ConsoleMetricExporter()
  let result
  exporter.export({ scopeMetrics: scopes }, r => (result = r))
  expect(result).to.deep.equal({ code: 0 /* ExportResultCode.SUCCESS */ })
  return infoCalls.map(args => args[0])
}

// --- assertions ------------------------------------------------------------

const { expect } = require('@cap-js/cds-test')

const APP_SCOPE = '@cap-js/telemetry'
const HOST_SCOPE = '@opentelemetry/instrumentation-host-metrics'

describe('ConsoleMetricExporter', () => {
  describe('db.pool table', () => {
    it('renders a "db.pool:" header and the size/available/pending table row', () => {
      const scopes = [
        scopeMetrics(APP_SCOPE, [
          metric('db.pool.size', [{ attributes: {}, value: 3 }]),
          metric('db.pool.max', [{ attributes: {}, value: 10 }]),
          metric('db.pool.available', [{ attributes: {}, value: 2 }]),
          metric('db.pool.pending', [{ attributes: {}, value: 1 }])
        ])
      ]

      const [line] = exportAndCapture(scopes)

      expect(infoCalls.length).to.equal(1)
      expect(line).to.match(/^db\.pool:/)
      // Column header
      expect(line).to.include('size | available | pending')
      // size/max, available/size, pending — padded into the row
      expect(line).to.match(/3\/10 \| +2\/3 \| +1/)
    })

    it('labels the table with the tenant id when a datapoint carries sap.tenancy.tenant_id', () => {
      const attributes = { 'sap.tenancy.tenant_id': 't1' }
      const scopes = [
        scopeMetrics(APP_SCOPE, [
          metric('db.pool.size', [{ attributes, value: 5 }]),
          metric('db.pool.max', [{ attributes, value: 8 }]),
          metric('db.pool.available', [{ attributes, value: 4 }]),
          metric('db.pool.pending', [{ attributes, value: 0 }])
        ])
      ]

      const [line] = exportAndCapture(scopes)

      expect(line).to.match(/^db\.pool of tenant "t1":/)
      expect(line).to.match(/5\/8 \| +4\/5 \| +0/)
    })
  })

  describe('queue table', () => {
    it('renders a "queue:" header, the wide column header, and lands the values', () => {
      const dp = value => [{ attributes: {}, value }]
      const scopes = [
        scopeMetrics(APP_SCOPE, [
          metric('queue.cold_entries', dp(1)),
          metric('queue.remaining_entries', dp(2)),
          metric('queue.min_storage_time_in_seconds', dp(3)),
          metric('queue.med_storage_time_in_seconds', dp(4)),
          metric('queue.max_storage_time_in_seconds', dp(5)),
          metric('queue.incoming_messages', dp(6)),
          metric('queue.outgoing_messages', dp(7)),
          metric('queue.processing_failures', dp(8))
        ])
      ]

      const [line] = exportAndCapture(scopes)

      expect(infoCalls.length).to.equal(1)
      expect(line).to.match(/^queue:/)
      // Column header (all eight columns)
      expect(line).to.include(
        'cold | remaining | min storage time | med storage time | max storage time | incoming | outgoing | failed'
      )
      // The eight values land in the padded row, in column order.
      const row = line.split('\n').at(-1)
      expect(row.split('|').map(c => c.trim())).to.deep.equal(['1', '2', '3', '4', '5', '6', '7', '8'])
    })

    it('labels the queue table with the tenant id when present', () => {
      const attributes = { 'sap.tenancy.tenant_id': 't2' }
      const dp = value => [{ attributes, value }]
      const scopes = [
        scopeMetrics(APP_SCOPE, [
          metric('queue.cold_entries', dp(0)),
          metric('queue.remaining_entries', dp(0)),
          metric('queue.min_storage_time_in_seconds', dp(0)),
          metric('queue.med_storage_time_in_seconds', dp(0)),
          metric('queue.max_storage_time_in_seconds', dp(0)),
          metric('queue.incoming_messages', dp(0)),
          metric('queue.outgoing_messages', dp(0)),
          metric('queue.processing_failures', dp(0))
        ])
      ]

      const [line] = exportAndCapture(scopes)

      expect(line).to.match(/^queue of tenant "t2":/)
    })
  })

  describe('other metrics', () => {
    it('logs a single-datapoint metric unwrapped (inspect of the datapoint object)', () => {
      const scopes = [
        scopeMetrics(APP_SCOPE, [metric('nodejs.eventloop.utilization', [{ attributes: {}, value: 0.42 }])])
      ]

      const [line] = exportAndCapture(scopes)

      expect(infoCalls.length).to.equal(1)
      // Unwrapped: inspect(v[0]) of a single datapoint object → starts with "{"
      expect(line).to.match(/^nodejs\.eventloop\.utilization: \{/)
      expect(line).to.include('value: 0.42')
      expect(line).not.to.match(/^nodejs\.eventloop\.utilization: \[/)
    })

    it('logs a multi-datapoint metric as an array (inspect of the datapoints array)', () => {
      const scopes = [
        scopeMetrics(APP_SCOPE, [
          metric('nodejs.eventloop.time', [
            { attributes: { 'nodejs.eventloop.state': 'active' }, value: 100 },
            { attributes: { 'nodejs.eventloop.state': 'idle' }, value: 200 }
          ])
        ])
      ]

      const [line] = exportAndCapture(scopes)

      expect(infoCalls.length).to.equal(1)
      // Wrapped: inspect(v) of the datapoints array → starts with "["
      expect(line).to.match(/^nodejs\.eventloop\.time: \[/)
      expect(line).to.include('value: 100')
      expect(line).to.include('value: 200')
    })

    it('labels other metrics with the tenant id when present', () => {
      const scopes = [
        scopeMetrics(APP_SCOPE, [metric('some.metric', [{ attributes: { 'sap.tenancy.tenant_id': 't3' }, value: 1 }])])
      ]

      const [line] = exportAndCapture(scopes)

      expect(line).to.match(/^some\.metric of tenant "t3": \{/)
    })
  })

  describe('host metrics', () => {
    const original = process.env.HOST_METRICS_LOG_SYSTEM

    afterEach(() => {
      if (original === undefined) delete process.env.HOST_METRICS_LOG_SYSTEM
      else process.env.HOST_METRICS_LOG_SYSTEM = original
    })

    // process.* metrics are always aggregated; a system.network.* metric is only aggregated when
    // HOST_METRICS_LOG_SYSTEM is set.
    function hostScope() {
      return [
        scopeMetrics(HOST_SCOPE, [
          metric('process.cpu.time', [{ attributes: { 'process.cpu.state': 'user' }, value: 1.5 }], 'process cpu time'),
          metric('process.memory.usage', [{ attributes: {}, value: 123456 }], 'process memory usage'),
          metric(
            'system.network.io',
            [{ attributes: { device: 'eth0', direction: 'receive' }, value: 999 }],
            'system network io'
          )
        ])
      ]
    }

    it('aggregates only process.* into a "host metrics:" block when HOST_METRICS_LOG_SYSTEM is unset', () => {
      delete process.env.HOST_METRICS_LOG_SYSTEM

      const [line] = exportAndCapture(hostScope())

      expect(infoCalls.length).to.equal(1)
      expect(line).to.match(/^host metrics:/)
      expect(line).to.include('process cpu time')
      expect(line).to.include('process memory usage')
      // system.* excluded when the flag is unset
      expect(line).not.to.include('system network io')
    })

    it('additionally aggregates system.* when HOST_METRICS_LOG_SYSTEM is set', () => {
      process.env.HOST_METRICS_LOG_SYSTEM = 'true'

      const [line] = exportAndCapture(hostScope())

      expect(infoCalls.length).to.equal(1)
      expect(line).to.match(/^host metrics:/)
      expect(line).to.include('process cpu time')
      expect(line).to.include('process memory usage')
      expect(line).to.include('system network io')
    })
  })

  describe('shutdown', () => {
    it('returns FAILED via setImmediate when the exporter is shutting down', () => {
      const exporter = new ConsoleMetricExporter()
      exporter._shutdown = true

      return new Promise(resolve => {
        exporter.export({ scopeMetrics: [] }, result => {
          expect(result).to.deep.equal({ code: 1 /* ExportResultCode.FAILED */ })
          expect(infoCalls.length).to.equal(0)
          resolve()
        })
      })
    })
  })
})
