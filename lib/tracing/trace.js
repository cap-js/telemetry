const cds = require('@sap/cds')

const otel = require('@opentelemetry/api')
const { SpanKind, SpanStatusCode, ROOT_CONTEXT } = otel
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')

const MASK_HEADERS = (cds.env.log.mask_headers || ['/authorization/i', '/cookie/i']).map(s => {
  const parts = s.match(/\/(.+)\/(\w*)/)
  if (parts) return new RegExp(parts[1], parts[2])
  return new RegExp(s)
})

const HRTIME = cds.env.requires.telemetry.tracing._hrtime
const EPOCH_OFFSET = Math.floor(Date.now() / 1000) - process.hrtime()[0]

// returns [seconds, nanoseconds] since unix epoch
function _hrtime() {
  const hrtime = process.hrtime()
  return [hrtime[0] + EPOCH_OFFSET, hrtime[1]]
}

function _getParentSpan() {
  if (!cds.context) return
  if (!cds.context._otelctx) {
    cds.context._otelKey = otel.createContextKey(cds.context.id)
    cds.context._otelctx = otel.context.active()
    const parent = otel.trace.getSpan(cds.context._otelctx)
    if (HRTIME && parent && !parent.__adjusted) {
      parent.startTime = _hrtime()
      parent.__adjusted = true
    }
    if (!parent?._is_async) cds.context._otelctx.setValue(cds.context._otelKey, parent)
  }
  return otel.context.active().getValue(cds.context._otelKey) || cds.context._otelctx.getValue(cds.context._otelKey)
}

function _getSpanName(arg, fn, targetObj) {
  const { phase, event, path } = arg

  if (targetObj.dbc) {
    return `db - ${event}${!(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) ? ` ${arg.target?.name || arg.path}` : ''}`
  }

  if (fn.name && targetObj.constructor.name !== 'OData') {
    if (phase) return `${targetObj.name}.${fn.name} - ${phase} - ${event}${path ? ` ${path}` : ''}`
    return `${targetObj.name} - ${event}${path ? ` ${path}` : ''}`
  }

  const trgt = targetObj.name ? `${targetObj.name} - ` : ''
  const phs = phase ? `${phase} - ` : ''
  const pth = event.match(/cds\.spawn/) ? '' : path ? ` ${path}` : ' *'
  return `${trgt}${phs}${event}${pth}`
}

function _determineKind(targetObj, phase, isAsyncConsumer, options) {
  // DB Calls & Remote calls are client calls
  if (targetObj.dbc || targetObj.constructor.name === 'RemoteService' || options.outbound) return SpanKind.CLIENT
  if (targetObj.constructor.name === 'cds' || phase === 'emit')
    // cds.spawn or srv.emit
    return SpanKind.PRODUCER
  if (isAsyncConsumer) return SpanKind.CONSUMER
  return SpanKind.INTERNAL
}

function _getStaticAttributes(fn) {
  if (!fn.__attributes) {
    const attributes = new Map()

    if (fn.name) attributes.set(SemanticAttributes.CODE_FUNCTION, fn.name)

    if (fn.__location) {
      const location = fn.__location
      const path = location.url.replace('file://', '')
      attributes.set(SemanticAttributes.CODE_FILEPATH, path)
      const namespace = path.match(/\/node_modules\//) ? path.split('/node_modules/')[1] : path
      attributes.set(SemanticAttributes.CODE_NAMESPACE, namespace)
      attributes.set(SemanticAttributes.CODE_LINENO, location.line)
      // REVISIT: SemanticAttributes.CODE_COLUMN did not yet exists when programming
      attributes.set('code.column', location.column)
    }

    const VCAP_APPLICATION = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)
    if (VCAP_APPLICATION) {
      attributes.set('server.port', VCAP_APPLICATION.port)
    }

    fn.__attributes = attributes
  }

  return fn.__attributes
}

function _getRequestAttributes() {
  if (!cds.context?.http?.req) return

  if (!cds.context.http.req.__attributes) {
    const req = cds.context.http.req

    const attributes = new Map()

    attributes.set('server.address', req.headers.host)
    attributes.set('url.full', req.protocol + '://' + req.headers.host + req.url)
    attributes.set('url.scheme', req.protocol)
    const [path, query] = req.url.split('?')
    attributes.set('url.path', path)
    if (query) attributes.set('url.query', query)

    attributes.set('http.method', req.method) //> Semantic Conventions < 1.24.0
    attributes.set('http.request.method', req.method) //> Semantic Conventions >= 1.24.0

    for (const [key, value] of Object.entries(cds.context.http.req.headers || {})) {
      if (MASK_HEADERS.some(m => key.match(m))) attributes.set(`http.request.header.${key}`, '***')
      else attributes.set(`http.request.header.${key}`, value.split(';'))
    }

    cds.context.http.req.__attributes = attributes
  }

  return cds.context.http.req.__attributes
}

function _getStaticDBAttributes() {
  if (!module.exports.__dbAttributes) {
    const attributes = (module.exports.__dbAttributes = new Map())
    attributes.set(SemanticAttributes.DB_SYSTEM, cds.db.options.kind) // hanadb, postgresql, sqlite
    attributes.set(SemanticAttributes.DB_NAME, cds.db.vcap?.name || cds.db.name)
    attributes.set(SemanticAttributes.DB_USER, cds.db.options.credentials.user)
    attributes.set(SemanticAttributes.DB_CONNECTION_STRING, cds.db.options.credentials.url)
    attributes.set(SemanticAttributes.NET_PEER_NAME, cds.env.requires.db.credentials.host)
    attributes.set(SemanticAttributes.NET_PEER_PORT, cds.env.requires.db.credentials.port)
    module.exports.__dbAttributes = attributes
  }
  return module.exports.__dbAttributes
}

// // REVISIT: sap.cds.entity
// function _updateAttributeMapBasedOnRequestType(args, attributeMap) {
//   if (Array.isArray(args) && args.length > 0) {
//     switch (args[0].constructor.name) {
//       case 'Request':
//         attributeMap.set('sap.cds.entity', args[0].context.entity)
//         break
//       case 'ODataRequest':
//         attributeMap.set('sap.cds.entity', args[0].entity)
//         break
//       default:
//         break
//     }
//   }
// }

function _setAttributes(span, attributes) {
  if (!attributes || !(attributes instanceof Map)) return
  attributes.forEach((value, key) => span.setAttribute(key, value))
}

function trace(name, fn, targetObj, args, options = {}) {
  // REVISIT: only start tracing once served
  if (!cds._telemetry.tracer._active) return fn.apply(targetObj, args)

  /*
   * create span
   */
  const parentSpan = _getParentSpan()
  const isAsync = parentSpan?._is_async && !parentSpan?.name.match(/cds\.spawn/)
  const ctx = isAsync
    ? ROOT_CONTEXT
    : parentSpan
    ? otel.trace.setSpan(otel.context.active(), parentSpan)
    : otel.context.active()
  const spanOptions = {
    kind: _determineKind(targetObj, name?.phase, isAsync, options)
  }
  if (HRTIME) spanOptions.startTime = _hrtime()
  if (isAsync) {
    spanOptions.links = [{ context: parentSpan.spanContext() }]
    spanOptions.parent = undefined
  }
  // REVISIT: better way to get tracer?
  const spanName = typeof name === 'string' ? name : _getSpanName(name, fn, targetObj)
  const span = cds._telemetry.tracer.startSpan(spanName, spanOptions, ctx)
  if (name.event?.match(/^cds\.spawn/) || name?.phase === 'emit') span._is_async = true

  /*
   * set attributes on span
   */
  _setAttributes(span, _getStaticAttributes(fn))
  _setAttributes(span, _getRequestAttributes())
  if (targetObj.dbc || options.sql) {
    _setAttributes(span, _getStaticDBAttributes())
    const dbAttributes = new Map()
    if (options.sql) {
      dbAttributes.set(SemanticAttributes.DB_STATEMENT, options.sql)
      parentSpan.attributes[SemanticAttributes.DB_OPERATION] &&
        dbAttributes.set(SemanticAttributes.DB_OPERATION, parentSpan.attributes[SemanticAttributes.DB_OPERATION])
      parentSpan.attributes[SemanticAttributes.DB_SQL_TABLE] &&
        dbAttributes.set(SemanticAttributes.DB_SQL_TABLE, parentSpan.attributes[SemanticAttributes.DB_SQL_TABLE])
    } else {
      dbAttributes.set(SemanticAttributes.DB_OPERATION, args[0].event)
      dbAttributes.set(SemanticAttributes.DB_SQL_TABLE, args[0].target?.name)
    }
    _setAttributes(span, dbAttributes)
  }
  const otherAttributes = new Map()
  if (cds.context?.tenant) otherAttributes.set('sap.tenancy.tenant_id', cds.context.tenant)
  if (options.outbound) otherAttributes.set('sap.btp.destination', options.outbound)
  // _updateAttributeMapBasedOnRequestType(args, otherAttributes)
  _setAttributes(span, otherAttributes)

  /*
   * call original function and subsequently end trace in callback
   */
  return otel.context.with(cds.context?._otelctx.setValue(cds.context._otelKey, span), () => {
    const onSuccess = res => {
      span.setStatus({ code: SpanStatusCode.OK })
      return res
    }
    const onFailure = e => {
      span.recordException(e)
      span.setStatus(Object.assign({ code: SpanStatusCode.ERROR }, e.message ? { message: e.message } : undefined))
      throw e
    }
    const onDone = () => {
      if (span.status.code !== SpanStatusCode.UNSET && !span.ended) span.end(HRTIME ? _hrtime() : undefined)
    }

    try {
      const res = fn.apply(targetObj, args)
      if (res instanceof Promise) return res.then(onSuccess).catch(onFailure).finally(onDone)
      return onSuccess(res)
    } catch (e) {
      onFailure(e)
    } finally {
      onDone()
    }
  })
}

module.exports = trace
