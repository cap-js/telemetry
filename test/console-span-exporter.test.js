// Unit tests for ConsoleSpanExporter — verifies the user-friendly hierarchy formatting
// (the "elapsed times:" primer + indented child lines) by feeding the exporter crafted
// ReadableSpan-shaped fixtures and inspecting the formatted string passed to LOG.info.
//
// This is a pure unit test: no cds.test server, no real OTel SDK, no console spying.

const cds = require('@sap/cds')

// Hook LOG.info BEFORE requiring the exporter so the exporter's module-level
// `cds.log('telemetry')` resolves to a logger whose .info we control.
const infoCalls = []
const telemetryLog = cds.log('telemetry')
const originalInfo = telemetryLog.info
telemetryLog.info = (...args) => infoCalls.push(args)

const ConsoleSpanExporter = require('../lib/exporter/ConsoleSpanExporter')

afterAll(() => {
  telemetryLog.info = originalInfo
})

beforeEach(() => {
  infoCalls.length = 0
})

// --- helpers ---------------------------------------------------------------

// Builds a minimal ReadableSpan-shaped object. Times are in OTel HrTime = [seconds, nanos].
function span({ name, traceId, spanId, parentSpanId, startMs = 0, durationMs = 0, attributes = {} }) {
  const startHr = msToHr(startMs)
  const durationHr = msToHr(durationMs)
  const endHr = msToHr(startMs + durationMs)
  return {
    name,
    kind: 0,
    spanContext: () => ({ traceId, spanId }),
    parentSpanContext: parentSpanId ? { traceId, spanId: parentSpanId } : undefined,
    startTime: startHr,
    endTime: endHr,
    duration: durationHr,
    status: { code: 0 },
    attributes,
    links: [],
    events: [],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0
  }
}

function msToHr(ms) {
  const seconds = Math.floor(ms / 1000)
  const nanos = Math.round((ms - seconds * 1000) * 1e6)
  return [seconds, nanos]
}

// Drives the exporter and returns the lines logged across all root primers.
function exportAndCapture(spans) {
  const exporter = new ConsoleSpanExporter()
  let result
  exporter.export(spans, r => (result = r))
  expect(result).to.deep.equal({ code: 0 /* ExportResultCode.SUCCESS */ })
  return infoCalls.map(args => args[0])
}

// --- assertions ------------------------------------------------------------

const { expect } = require('chai')

describe('ConsoleSpanExporter', () => {
  describe('hierarchy formatting', () => {
    it('emits a single "elapsed times:" primer per root and nests children by depth', () => {
      // Tree shape:
      //   root  (0 → 10 ms)
      //     childA (1 → 4 ms)
      //       grandchild (2 → 3 ms)
      //     childB (5 → 9 ms)
      const TRACE = 'a'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 10 })
      const childA = span({ name: 'childA', traceId: TRACE, spanId: 'cA', parentSpanId: 'r0', startMs: 1, durationMs: 3 })
      const grand = span({ name: 'grandchild', traceId: TRACE, spanId: 'g0', parentSpanId: 'cA', startMs: 2, durationMs: 1 })
      const childB = span({ name: 'childB', traceId: TRACE, spanId: 'cB', parentSpanId: 'r0', startMs: 5, durationMs: 4 })

      // Order matters: children must arrive BEFORE the root for the exporter's
      // temporaryStorage flush logic to merge them under the same primer.
      const [primer] = exportAndCapture([childA, grand, childB, root])

      // Single primer
      expect(infoCalls.length).to.equal(1)
      expect(primer).to.match(/^elapsed times:/)

      // Root line: 0.00 → 10.00 = 10.00 ms  root  (no indent on the root data line)
      expect(primer).to.match(/\n  +0\.00 → +10\.00 = +10\.00 ms {2}root/)

      // First-level children indented by 2 spaces beyond root
      expect(primer).to.match(/\n.+ ms {4}childA/)
      expect(primer).to.match(/\n.+ ms {4}childB/)

      // Grandchild indented by 4 spaces beyond root
      expect(primer).to.match(/\n.+ ms {6}grandchild/)

      // Ordering: childA appears before grandchild appears before childB
      expect(primer.indexOf('childA')).to.be.lessThan(primer.indexOf('grandchild'))
      expect(primer.indexOf('grandchild')).to.be.lessThan(primer.indexOf('childB'))
    })

    it('relativizes child start/end to the root start time', () => {
      // Root starts at 100 ms wallclock; child at 105 ms. Child should display as 5.00 → ...
      const TRACE = 'b'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 100, durationMs: 20 })
      const child = span({ name: 'child', traceId: TRACE, spanId: 'c0', parentSpanId: 'r0', startMs: 105, durationMs: 10 })

      const [primer] = exportAndCapture([child, root])

      expect(primer).to.match(/0\.00 → +20\.00 = +20\.00 ms {2}root/)
      expect(primer).to.match(/5\.00 → +15\.00 = +10\.00 ms {4}child/)
    })

    it('sorts sibling spans by start time, ties broken by later end-time first', () => {
      const TRACE = 'c'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 50 })
      const late = span({ name: 'late', traceId: TRACE, spanId: 's3', parentSpanId: 'r0', startMs: 10, durationMs: 1 })
      const earlyLong = span({ name: 'earlyLong', traceId: TRACE, spanId: 's1', parentSpanId: 'r0', startMs: 0, durationMs: 30 })
      const earlyShort = span({ name: 'earlyShort', traceId: TRACE, spanId: 's2', parentSpanId: 'r0', startMs: 0, durationMs: 5 })

      const [primer] = exportAndCapture([late, earlyShort, earlyLong, root])

      // Equal start time → longer span first; otherwise by start time ascending
      const order = ['earlyLong', 'earlyShort', 'late'].map(n => primer.indexOf(n))
      expect(order[0]).to.be.lessThan(order[1])
      expect(order[1]).to.be.lessThan(order[2])
    })

    it('emits a separate primer per trace (multi-root)', () => {
      const T1 = 'd'.repeat(32),
        T2 = 'e'.repeat(32)
      const r1 = span({ name: 'root1', traceId: T1, spanId: 'r1', startMs: 0, durationMs: 5 })
      const c1 = span({ name: 'c1', traceId: T1, spanId: 'c1', parentSpanId: 'r1', startMs: 1, durationMs: 2 })
      const r2 = span({ name: 'root2', traceId: T2, spanId: 'r2', startMs: 0, durationMs: 7 })
      const c2 = span({ name: 'c2', traceId: T2, spanId: 'c2', parentSpanId: 'r2', startMs: 1, durationMs: 3 })

      exportAndCapture([c1, c2, r1, r2])

      expect(infoCalls.length).to.equal(2)
      const all = infoCalls.map(c => c[0])
      expect(all[0]).to.include('root1').and.to.include('c1').and.not.to.include('root2')
      expect(all[1]).to.include('root2').and.to.include('c2').and.not.to.include('root1')
    })

    it('skips short "METHOD /word" spans (e.g. unadjusted http instrumentation roots)', () => {
      const TRACE = 'f'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 10 })
      // The skip regex is /^[A-Z]+ \/\${0,1}\w+$/ — single path segment, no slashes after the first.
      const noisy = span({ name: 'GET /catalog', traceId: TRACE, spanId: 'h0', parentSpanId: 'r0', startMs: 1, durationMs: 5 })

      const [primer] = exportAndCapture([noisy, root])

      expect(primer).to.include('root')
      expect(primer).not.to.include('GET /catalog')
    })

    it('handles deep nesting with increasing indentation', () => {
      const TRACE = '1'.repeat(32)
      const root = span({ name: 'L0', traceId: TRACE, spanId: 'L0', startMs: 0, durationMs: 10 })
      const l1 = span({ name: 'L1', traceId: TRACE, spanId: 'L1', parentSpanId: 'L0', startMs: 1, durationMs: 8 })
      const l2 = span({ name: 'L2', traceId: TRACE, spanId: 'L2', parentSpanId: 'L1', startMs: 2, durationMs: 6 })
      const l3 = span({ name: 'L3', traceId: TRACE, spanId: 'L3', parentSpanId: 'L2', startMs: 3, durationMs: 4 })

      const [primer] = exportAndCapture([l1, l2, l3, root])

      // Each deeper level adds 2 spaces of indentation
      const indents = ['L0', 'L1', 'L2', 'L3'].map(n => {
        const m = primer.match(new RegExp(`\\n( +)\\d.*ms( +)${n}(?!\\d)`))
        return m ? m[2].length - 1 : null // exclude the single space separator after "ms "
      })
      // L0: 1 leading space before the name; each child adds 2. So we expect 1, 3, 5, 7.
      expect(indents).to.deep.equal([1, 3, 5, 7])
    })
  })

  describe('time formatting', () => {
    it('formats sub-millisecond durations with two decimals', () => {
      const TRACE = '2'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 0.5 })
      const [primer] = exportAndCapture([root])
      expect(primer).to.match(/0\.00 → +0\.50 = +0\.50 ms/)
    })

    it('right-aligns integer portion to 3 chars', () => {
      const TRACE = '3'.repeat(32)
      const root = span({ name: 'root', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 123 })
      const [primer] = exportAndCapture([root])
      // "123.00" → matches as-is, fits in the 3-char integer slot
      expect(primer).to.match(/0\.00 → +123\.00 = +123\.00 ms/)
    })
  })

  describe('span name handling', () => {
    it('truncates names longer than 80 chars with an ellipsis', () => {
      const TRACE = '4'.repeat(32)
      const longName = 'X'.repeat(100)
      const root = span({ name: longName, traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 1 })

      const [primer] = exportAndCapture([root])

      expect(primer).to.include('X'.repeat(79) + '…')
      expect(primer).not.to.include('X'.repeat(80))
    })
  })

  describe('robustness', () => {
    it('does not throw when a child arrives without its parent (orphan trace)', () => {
      // No root provided for this trace — the exporter should buffer the child and not flush.
      const TRACE = '5'.repeat(32)
      const orphan = span({ name: 'orphan', traceId: TRACE, spanId: 'o0', parentSpanId: 'r-missing', startMs: 0, durationMs: 1 })

      expect(() => exportAndCapture([orphan])).not.to.throw()
      expect(infoCalls.length).to.equal(0)
    })

    it('treats any span without a parent as a root and emits a primer', () => {
      const TRACE = '6'.repeat(32)
      const lonely = span({ name: 'lonely', traceId: TRACE, spanId: 'r0', startMs: 0, durationMs: 2 })

      const [primer] = exportAndCapture([lonely])

      expect(primer).to.match(/^elapsed times:/)
      expect(primer).to.include('lonely')
    })

    it('shutdown flushes pending buffered children without throwing', () => {
      const exporter = new ConsoleSpanExporter()
      // No-op: just verify the shutdown contract.
      return exporter.shutdown().then(() => {
        // No exception, no logged primers (nothing was buffered).
        expect(infoCalls.length).to.equal(0)
      })
    })
  })
})
