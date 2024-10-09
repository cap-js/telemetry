const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const path = require('path')

const { ExportResultCode, hrTimeToMilliseconds } = require('@opentelemetry/core')
const {
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_CODE_FILEPATH,
  SEMATTRS_CODE_LINENO
  // SEMATTRS_CODE_COLUMN
} = require('@opentelemetry/semantic-conventions')
// REVISIT: SEMATTRS_CODE_COLUMN doesn't yet exist in semantic conventions 1.25
const SEMATTRS_CODE_COLUMN = 'code.column'

const _padded = v =>
  `${`${v}`.split('.')[0].padStart(3, ' ')}.${(`${v}`.split('.')[1] || '0').padEnd(2, '0').substring(0, 2)}`

const _span2line = (span, parentStartTime = 0) => {
  if (span.name.match(/^[A-Z]+ \/\${0,1}\w+$/)) return ''

  const start = parentStartTime ? hrTimeToMilliseconds(span.startTime) - hrTimeToMilliseconds(parentStartTime) : 0
  const duration = hrTimeToMilliseconds(span.duration)
  const end = start + duration

  let result = `\n  ${_padded(start)} → ${_padded(end)} = ${_padded(duration)} ms`

  let name = span.name
  if (name.match(/^[A-Z]+$/)) name = name + ' ' + span.attributes[SEMATTRS_HTTP_TARGET]
  if (name.length > 80) name = name.substring(0, 79) + '…'

  result += '  ' + (span.___indent || '') + name

  // REVISIT: what is this for?
  if (span.attributes[SEMATTRS_CODE_FILEPATH] !== undefined) {
    if (
      path
        .normalize(span.attributes[SEMATTRS_CODE_FILEPATH])
        .match(new RegExp(path.normalize(cds.env._home).replaceAll('\\', '\\\\'), 'g')) &&
      !path.normalize(span.attributes[SEMATTRS_CODE_FILEPATH]).match(/node_modules/g)
    ) {
      result += `: .${path
        .normalize(span.attributes[SEMATTRS_CODE_FILEPATH])
        .substring(
          path.normalize(cds.env._home).length + 1,
          path.normalize(span.attributes[SEMATTRS_CODE_FILEPATH]).length
        )}:${span.attributes[SEMATTRS_CODE_LINENO]}:${span.attributes[SEMATTRS_CODE_COLUMN]}`
    }
  }

  return result
}

const _span_sorter = (a, b) => {
  const d = hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime)
  if (d !== 0) return d
  return hrTimeToMilliseconds(b.endTime) - hrTimeToMilliseconds(a.endTime) //> the one ending later should be printed first
}

const _list2tree = (span, spans, flat, indent) => {
  const spanId = span.spanContext().spanId
  const children = spans.filter(s => s.parentSpanId === spanId)
  if (children.length === 0) return
  children.sort(_span_sorter)
  for (const each of children) {
    each.___indent = indent + '  '
    flat.push(each)
    _list2tree(each, spans, flat, each.___indent)
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
      const w3c_parent_id = cds.context.http?.req.headers.traceparent?.split('-')[2]
      if (!span.parentSpanId || span.parentSpanId === w3c_parent_id || span.name === 'cds.spawn') {
        let toLog = 'elapsed times:'
        toLog += _span2line(span)
        const children = this._temporaryStorage.get(span.spanContext().traceId)
        if (children) {
          const ids = new Set(children.map(s => s.spanContext().spanId).filter(s => !!s))
          const reqs = children.filter(s => s.spanContext().spanId && !ids.has(s.parentSpanId))
          const flat = []
          reqs.sort(_span_sorter)
          for (const each of reqs) {
            each.___indent = '  '
            flat.push(each)
            _list2tree(each, children, flat, each.___indent)
          }
          for (const each of flat) toLog += _span2line(each, span.startTime)
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
