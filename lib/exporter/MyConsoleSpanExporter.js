const cds = require('@sap/cds')
const LOG = cds.log('otel', { label: 'otel:traces' })

const path = require('path')

const { ExportResultCode, hrTimeToMilliseconds /* , hrTimeToTimeStamp */ } = require('@opentelemetry/core')

function span2line(span, hasParent, parentStartTime = 0) {
  const _padded = v =>
    `${`${v}`.split('.')[0].padStart(4, ' ')}.${(`${v}`.split('.')[1] || '0').padEnd(6, '0').substring(0, 6)}`
  let start = 0
  if (parentStartTime) {
    // REVISIT: using hrTimeToMilliseconds somehow doesn't work
    const s = span.startTime[0] - parentStartTime[0]
    const ns = span.startTime[1] - parentStartTime[1]
    start = Number(`${s}.${ns < 0 ? 1000000000 + ns : ns}`)
  }
  const duration = hrTimeToMilliseconds(span.duration)
  const end = start + duration
  const isDb = Object.keys(span.attributes).some(k => k.match(/^db\./))
  let result
  if (!hasParent) result = ' '
  else if (isDb) result = '\n        |-'
  else result = '\n       |- '
  result += `${_padded(duration)} ms (${_padded(start)} ms -> ${_padded(end)} ms) - ${span.name}`

  // REVISIT: what is this for?
  if (span.attributes['code.filepath'] !== undefined) {
    if (
      path
        .normalize(span.attributes['code.filepath'])
        .match(new RegExp(path.normalize(cds.env._home).replaceAll('\\', '\\\\'), 'g')) &&
      !path.normalize(span.attributes['code.filepath']).match(/node_modules/g)
    ) {
      result += `: .${path
        .normalize(span.attributes['code.filepath'])
        .substring(
          path.normalize(cds.env._home).length + 1,
          path.normalize(span.attributes['code.filepath']).length
        )}:${span.attributes['code.lineno']}:${span.attributes['code.column']}`
    }
  }

  return result
}

/**
 * This is implementation of {@link SpanExporter} that prints spans as single lines to the
 * console. This class can be used for diagnostic purposes.
 */
class MyConsoleSpanExporter /* implements SpanExporter */ {
  _temporaryStorage = new Map()

  /**
   * Export spans.
   * @param spans
   * @param resultCallback
   */
  export(spans /* : ReadableSpan[] */, resultCallback /* : (result: ExportResult) => void */) /* : void */ {
    return this._sendSpans(spans, resultCallback)
  }

  /**
   * Shutdown the exporter.
   */
  shutdown() {
    this._sendSpans([])
    return Promise.resolve()
  }

  /**
   * Showing spans in console
   * @param spans
   * @param done
   */
  _sendSpans(spans, done) {
    if (cds.server.url) {
      // Ensures that db init calls during startup are not traced in console
      for (const span of spans) {
        if (!span.parentSpanId) {
          // REVISIT: what is span.attributes['sap.cds.logger']?
          // cds default required for express spans
          // let toLog = `trace for "${span.attributes['sap.cds.logger'] || 'cds'}": ${exportInfoString(span, false)}`
          let toLog = span2line(span, false)
          const furtherLogsToPrint = this._temporaryStorage.get(span.spanContext().traceId)
          if (furtherLogsToPrint) {
            furtherLogsToPrint
              .sort((a, b) => {
                const d = hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime)
                if (d !== 0) return d
                return hrTimeToMilliseconds(b.endTime) - hrTimeToMilliseconds(a.endTime) //> the one ending later should be printed first
              })
              .forEach(t => (toLog += span2line(t, true, span.startTime)))
            this._temporaryStorage.delete(span.spanContext().traceId)
          }
          LOG.info(toLog)
        } else {
          const result = this._temporaryStorage.get(span.spanContext().traceId)
          if (!result) this._temporaryStorage.set(span.spanContext().traceId, [span])
          else result.push(span)
        }
      }
    }

    if (done) return done({ code: ExportResultCode.SUCCESS })
  }
}

module.exports = MyConsoleSpanExporter
