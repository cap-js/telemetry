const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const path = require('path')

const { ExportResultCode, hrTimeToMilliseconds } = require('@opentelemetry/core')
const {
  ATTR_URL_PATH,
  ATTR_CODE_FILE_PATH,
  ATTR_CODE_LINE_NUMBER,
  ATTR_CODE_COLUMN_NUMBER
} = require('@opentelemetry/semantic-conventions')

// Format a number as `___.dd` (3-char integer slot, 2-decimal fraction, rounded).
// Note: prior implementation truncated the fractional part via string-substring, which read
// `1.567 ms` as `1.56 ms` — toFixed rounds.
const _padded = v => {
  const [int, frac] = Number(v).toFixed(2).split('.')
  return `${int.padStart(3, ' ')}.${frac}`
}

const _span2line = (span, parentStartTime = 0, indent = '') => {
  // Skip http-instrumentation spans that consist of method + path (e.g. `GET /foo`, `POST /odata/v4/admin/Books`).
  // These are folded into the root via the name-adjustment in lib/tracing/trace.js.
  if (span.name.match(/^[A-Z]+ \/\S*$/)) return ''

  const start = parentStartTime ? hrTimeToMilliseconds(span.startTime) - hrTimeToMilliseconds(parentStartTime) : 0
  const duration = hrTimeToMilliseconds(span.duration)
  const end = start + duration

  let result = `\n  ${_padded(start)} → ${_padded(end)} = ${_padded(duration)} ms`

  let name = span.name
  if (name.match(/^[A-Z]+$/))
    name = name + ' ' + (span.attributes[ATTR_URL_PATH] || span.attributes['http.target'] || 'unknown')
  if (name.length > 80) name = name.substring(0, 79) + '…'

  result += '  ' + indent + name

  // REVISIT: what is this for?
  if (span.attributes[ATTR_CODE_FILE_PATH] !== undefined) {
    if (
      path
        .normalize(span.attributes[ATTR_CODE_FILE_PATH])
        .match(new RegExp(path.normalize(cds.env._home).replaceAll('\\', '\\\\'), 'g')) &&
      !path.normalize(span.attributes[ATTR_CODE_FILE_PATH]).match(/node_modules/g)
    ) {
      result += `: .${path
        .normalize(span.attributes[ATTR_CODE_FILE_PATH])
        .substring(
          path.normalize(cds.env._home).length + 1,
          path.normalize(span.attributes[ATTR_CODE_FILE_PATH]).length
        )}:${span.attributes[ATTR_CODE_LINE_NUMBER]}:${span.attributes[ATTR_CODE_COLUMN_NUMBER]}`
    }
  }

  return result
}

const _span_sorter = (a, b) => {
  const d = hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime)
  if (d !== 0) return d
  return hrTimeToMilliseconds(b.endTime) - hrTimeToMilliseconds(a.endTime) //> the one ending later should be printed first
}

// Walks the span tree depth-first and pushes `{ span, indent }` pairs into `out` in print order.
// The indent string is carried via the recursion, not stored on the spans — ReadableSpan instances
// are conceptually immutable post-`end()`, so we don't mutate them here.
const _list2tree = (span, spans, out, indent) => {
  const spanId = span.spanContext().spanId
  const children = spans.filter(s => s.parentSpanContext?.spanId === spanId)
  if (children.length === 0) return
  children.sort(_span_sorter)
  const childIndent = indent + '  '
  for (const each of children) {
    out.push({ span: each, indent: childIndent })
    _list2tree(each, spans, out, childIndent)
  }
}

/**
 * This is implementation of {@link SpanExporter} that prints spans as single lines to the
 * console. This class can be used for diagnostic purposes.
 */
class ConsoleSpanExporter /* implements SpanExporter */ {
  _temporaryStorage = new Map()

  /**
   * Export spans.
   * @param spans
   * @param resultCallback
   */
  export(spans, resultCallback) {
    return this._sendSpans(spans, resultCallback)
  }

  /**
   * Shutdown the exporter.
   */
  shutdown() {
    // REVISIT: pending children in `_temporaryStorage` whose root never arrived are silently
    //          dropped here. Consider flushing remaining buckets as separate primers (or at least logging
    //          a debug message noting how much data was lost) once we decide on the UX for partial traces.
    this._sendSpans([])
    return Promise.resolve()
  }

  /**
   * Showing spans in console
   * @param spans
   * @param done
   */
  _sendSpans(spans, done) {
    for (const span of spans) {
      const w3c_parent_id = cds.context?.http?.req?.headers?.traceparent?.split('-')[2]
      if (!span.parentSpanContext?.spanId || span.parentSpanContext?.spanId === w3c_parent_id) {
        let toLog = 'elapsed times:'
        toLog += _span2line(span)
        const children = this._temporaryStorage.get(span.spanContext().traceId)
        if (children) {
          const ids = new Set(children.map(s => s.spanContext().spanId).filter(s => !!s))
          const reqs = children.filter(s => s.spanContext().spanId && !ids.has(s.parentSpanContext?.spanId))
          // Build a flat, depth-first list of { span, indent } in print order.
          const flat = []
          reqs.sort(_span_sorter)
          for (const each of reqs) {
            flat.push({ span: each, indent: '  ' })
            _list2tree(each, children, flat, '  ')
          }
          for (const { span: s, indent } of flat) toLog += _span2line(s, span.startTime, indent)
          this._temporaryStorage.delete(span.spanContext().traceId)
        }
        LOG.info(toLog)
      } else {
        const result = this._temporaryStorage.get(span.spanContext().traceId)
        if (!result) this._temporaryStorage.set(span.spanContext().traceId, [span])
        else result.push(span)
      }
    }

    if (done) return done({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = ConsoleSpanExporter
