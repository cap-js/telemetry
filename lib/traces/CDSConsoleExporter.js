const cds = require('@sap/cds'),
  path = require('path')
const { ExportResultCode, hrTimeToMilliseconds, hrTimeToTimeStamp } = require('@opentelemetry/core')

/**
 * This is implementation of {@link SpanExporter} that prints spans as single lines to the
 * console. This class can be used for diagnostic purposes.
 */

/* eslint-disable no-console */
class CDSConsoleExporter /* implements SpanExporter */ {
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
   * converts span info into more readable format
   * @param span
   */
  _exportInfoJSON(span) {
    return {
      traceId: span.spanContext().traceId,
      parentId: span.parentSpanId,
      traceState: span.spanContext().traceState?.serialize(),
      name: span.name,
      id: span.spanContext().spanId,
      kind: span.kind,
      timestamp: hrTimeToTimeStamp(span.startTime),
      duration: hrTimeToMilliseconds(span.duration),
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links
    }
  }

  _temporaryStorage = new Map()

  _exportInfoString(span, hasParent, parentStartTime = 0) {
    const startPoint = parentStartTime
      ? hrTimeToMilliseconds(span.startTime) - hrTimeToMilliseconds(parentStartTime)
      : 0
    const endPoint = `${startPoint + hrTimeToMilliseconds(span.duration)}`
    // cds default required for express spans
    let result = `[${span.attributes['sap.cds.logger'] || 'cds'}] - ${
      hasParent ? '>   ' : '    '
    }${`${startPoint}`.padStart(4, ' ')}ms -> ${endPoint.padStart(4, ' ')}ms = ${`${hrTimeToMilliseconds(
      span.duration
    )}`.padStart(4, ' ')}ms | '${span.name}'`
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
   * Showing spans in console
   * @param spans
   * @param done
   */
  _sendSpans(spans, done) {
    if (cds.server.url)
      // Ensures that db init calls during startup are not traced in console
      for (const span of spans) {
        if (!span.parentSpanId) {
          //Only for local export, hence console
          console.dir(this._exportInfoString(span, false), { depth: 3, breakLength: 111 })
          const furtherLogsToPrint = this._temporaryStorage.get(span.spanContext().traceId)
          if (furtherLogsToPrint) {
            furtherLogsToPrint
              .sort((s, b) => hrTimeToMilliseconds(s.startTime) - hrTimeToMilliseconds(b.startTime))
              .forEach(t =>
                //Only for local export, hence console
                console.dir(this._exportInfoString(t, true, span.startTime), { depth: 3, breakLength: 111 })
              )
            this._temporaryStorage.delete(span.spanContext().traceId)
          }
        } else {
          const result = this._temporaryStorage.get(span.spanContext().traceId)
          if (!result) this._temporaryStorage.set(span.spanContext().traceId, [span])
          else result.push(span)
        }
      }
    if (done) {
      return done({ code: ExportResultCode.SUCCESS })
    }
  }
}

module.exports = {
  CDSConsoleExporter
}
