// Integration tests for metrics collection — asserts on what is actually COLLECTED (which
// instruments produce datapoints, and how many), captured in-memory by MyInMemoryMetricReader
// (wired via the `metrics` profile in .cdsrc.json) instead of scraping ConsoleMetricExporter's
// log output. The formatting of those metrics is unit-tested in console-metric-exporter.test.js.

const cds = require('@sap/cds')

const { captured, forceFlush, reset } = require('./bookshop/lib/MyInMemoryMetricReader')
const { makeExpectEventually } = require('./bookshop/lib/test-utils')

const { expect, GET } = cds.test(__dirname + '/bookshop', '--profile', 'metrics')

// State-based wait for metric assertions: force the wired meter provider (forceFlush) to collect +
// export, then re-run the assertion block. Replaces fixed-time sleeps — the loop completes the
// instant the captured datapoints reflect the asserted state. forceFlush() throws fast if the
// provider isn't wired, so a misconfigured profile fails loudly instead of busy-spinning the timeout.
const expectEventually = makeExpectEventually(forceFlush, { timeout: 10000, interval: 25 })

// All metric descriptor names present across every captured export.
function capturedMetricNames() {
  const names = new Set()
  for (const rm of captured) {
    for (const scopeMetrics of rm.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) names.add(metric.descriptor.name)
    }
  }
  return names
}

// Most recent captured MetricData for the given descriptor name (newest export first).
function latestMetric(name) {
  for (let i = captured.length - 1; i >= 0; i--) {
    for (const scopeMetrics of captured[i].scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name === name && metric.dataPoints?.length) return metric
      }
    }
  }
  return null
}

describe('metrics', () => {
  const admin = { auth: { username: 'alice' } }

  beforeEach(reset)

  test('system metrics are not collected by default', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)

    await expectEventually(() => {
      const names = capturedMetricNames()
      // process.* host metrics ARE collected out of the box ...
      expect([...names].some(n => n.startsWith('process.'))).to.be.true
      // ... but system.* (network/cpu/memory) collection is NOT enabled by default.
      expect([...names].some(n => n.startsWith('system.'))).to.be.false
      expect([...names].some(n => n.includes('network'))).to.be.false
    })
  })

  test('other metrics can carry multiple datapoints', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)

    await expectEventually(() => {
      // nodejs.eventloop.time is collected with multiple datapoints (active + idle) ...
      const time = latestMetric('nodejs.eventloop.time')
      expect(time).to.exist
      expect(time.dataPoints.length).to.be.greaterThan(1)
      // ... whereas nodejs.eventloop.utilization is a single datapoint.
      const utilization = latestMetric('nodejs.eventloop.utilization')
      expect(utilization).to.exist
      expect(utilization.dataPoints.length).to.equal(1)
    })
  })
})
