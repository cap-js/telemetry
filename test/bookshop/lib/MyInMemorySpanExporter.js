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

module.exports = { MyInMemorySpanExporter, captured }
