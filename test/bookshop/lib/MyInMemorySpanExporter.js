// In-memory span exporter for tests. Spans are accumulated in a module-level array that
// tests can import directly via `require('./lib/MyInMemorySpanExporter').captured`.
// Wired into the tracer provider via .cdsrc.json profile config (no provider-poking from tests).

const { ExportResultCode } = require('@opentelemetry/core')

const captured = []

class MyInMemorySpanExporter {
  export(spans, resultCallback) {
    captured.push(...spans)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown() {
    return Promise.resolve()
  }

  forceFlush() {
    return Promise.resolve()
  }
}

// Returns the captured spans grouped by traceId, each group is a hierarchy:
//   { traceId, root, all, byParent }
// `root` is the span with no parent inside the group (the visible root for the exporter's
// "elapsed times:" primer logic — i.e. spans whose parentSpanId is not present in this group).
function groupedByTrace() {
  const byTrace = new Map()
  for (const s of captured) {
    const tid = s.spanContext().traceId
    if (!byTrace.has(tid)) byTrace.set(tid, [])
    byTrace.get(tid).push(s)
  }

  return [...byTrace.entries()].map(([traceId, all]) => {
    const ids = new Set(all.map(s => s.spanContext().spanId))
    const roots = all.filter(s => !s.parentSpanContext?.spanId || !ids.has(s.parentSpanContext.spanId))
    const byParent = new Map()
    for (const s of all) {
      const pid = s.parentSpanContext?.spanId
      if (!byParent.has(pid)) byParent.set(pid, [])
      byParent.get(pid).push(s)
    }
    return { traceId, root: roots[0], roots, all, byParent }
  })
}

// Returns just the visible "root" spans across all captured traces. These correspond 1:1 to
// "elapsed times:" primers our ConsoleSpanExporter would emit for the same data.
function rootSpans() {
  return groupedByTrace().flatMap(g => g.roots)
}

function reset() {
  captured.length = 0
}

module.exports = { MyInMemorySpanExporter, captured, groupedByTrace, rootSpans, reset }
