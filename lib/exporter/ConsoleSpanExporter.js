const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const path = require('path')

const { ExportResultCode, hrTimeToMilliseconds } = require('@opentelemetry/core')

const _padded = v =>
  `${`${v}`.split('.')[0].padStart(3, ' ')}.${(`${v}`.split('.')[1] || '0').padEnd(2, '0').substring(0, 2)}`

const _span2line = (span, hasParent, parentStartTime = 0, batch) => {
  if (span.name.match(/^[A-Z]+ \/\${0,1}\w+$/)) return ''

  const start = parentStartTime ? hrTimeToMilliseconds(span.startTime) - hrTimeToMilliseconds(parentStartTime) : 0
  const duration = hrTimeToMilliseconds(span.duration)
  const end = start + duration

  const isDb = Object.keys(span.attributes).some(k => k.match(/^db\./))

  let result = `\n  ${_padded(start)} → ${_padded(end)} = ${_padded(duration)} ms`

  let name = span.name
  if (name.match(/^[A-Z]+$/)) name = name + ' ' + span.attributes['http.target']
  if (name.length > 80) name = name.substring(0, 80) + '…'

  let indent = ''
  if (!hasParent) indent += '  '
  else {
    if (name.match(/ - exec /) || name.match(/ - prepare /) || name.match(/ - stmt./)) indent += '        '
    else if (isDb) indent += '      '
    else indent += '    '
    if (batch && !name.match(/^[A-Z]+\s.*$/)) indent += '  '
  }
  result += indent + name

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

const _span_sorter = (a, b) => {
  const d = hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime)
  if (d !== 0) return d
  return hrTimeToMilliseconds(b.endTime) - hrTimeToMilliseconds(a.endTime) //> the one ending later should be printed first
}

const _list2tree = (span, spans, flat) => {
  const id = span.attributes.___id
  const children = spans.filter(s => s.attributes.___parentId === id)
  if (children.length === 0) return
  children.sort(_span_sorter)
  for (const each of children) {
    flat.push(each)
    _list2tree(each, spans, flat)
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
    if (cds.server.url) {
      // Ensures that db init calls during startup are not traced in console
      for (const span of spans) {
        if (!span.parentSpanId) {
          let toLog = 'elapsed times:'
          toLog += _span2line(span, false)
          const children = this._temporaryStorage.get(span.spanContext().traceId)
          if (children) {
            const batch = !!span.attributes['http.url']?.match(/\/\$batch/)
            const ids = new Set(children.map(s => s.attributes.___id))
            const reqs = children.filter(s => !ids.has(s.attributes.___parentId))
            const flat = []
            reqs.sort(_span_sorter)
            for (const each of reqs) {
              flat.push(each)
              _list2tree(each, children, flat)
            }
            for (const each of flat) toLog += _span2line(each, true, span.startTime, batch)
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

module.exports = ConsoleSpanExporter
