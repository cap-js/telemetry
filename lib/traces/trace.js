const cds = require('@sap/cds')
const LOG = cds.log('otel:traces')

const { locate } = require('func-loc')
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')
const {
  SpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
  trace: otelTrace,
  context: otelContextAPI,
  createContextKey: otelCreateContextKey
} = require('@opentelemetry/api')

/**
 * @param {string|object} name
 * @param {*} func
 * @param {*} targetObj
 * @param {*} args
 * @param {String} options.loggerName
 * @param {String} options.outbound Name of BTP destination
 * @returns
 */
module.exports = async function trace(name, func, targetObj, args, options = {}) {
  const attributeMap = new Map()
  let spanName = typeof name === 'string' ? name : getSpanName(name, func, attributeMap, targetObj)

  attributeMap.set('sap.cds.logger', options.loggerName || LOG.label)
  try {
    const fileSourceDetails = await locate(func)
    const source = fileSourceDetails.source
    const buildNamespace = source => {
      const parts = source.split('/')
      if (parts.some(part => part === 'cds')) return source // cds module not processed
      const isInSrv = parts.some(part => part === 'srv')
      let namespace = '',
        srvPassed = false
      for (const part of parts) {
        if (isInSrv && !srvPassed) {
          if (part === 'srv') srvPassed = true
        } else namespace += `${namespace.length === 0 ? '' : '.'}${part}`
      }
      return namespace
    }
    attributeMap.set(SemanticAttributes.CODE_NAMESPACE, buildNamespace(source))
    attributeMap.set(SemanticAttributes.CODE_FILEPATH, fileSourceDetails.path)
    attributeMap.set(SemanticAttributes.CODE_LINENO, fileSourceDetails.line)
    attributeMap.set('code.column', fileSourceDetails.column) // REVISIT: SemanticAttributes.CODE_COLUMN did not yet exists when programming
  } catch {
    LOG.warn('Could not locate function and hence attributes are not specified in trace')
  }

  if (cds.context?.http?.headers) attributeMap.set('http.correlation-id', cds.context.http.headers['x-correlation-id'])
  if (cds.context?.tenant) attributeMap.set('sap.tenancy.tenant_id', cds.context.tenant) // https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/tenancy.md#sap-tenancy-related-otel-attributes

  if (targetObj.dbc) {
    // DB specific attributes
    attributeMap.set(SemanticAttributes.DB_SYSTEM, cds.db.options.kind) // hanadb, postgresql, sqlite
    attributeMap.set(SemanticAttributes.DB_NAME, cds.db.vcap?.name || cds.db.name)
    attributeMap.set(SemanticAttributes.DB_USER, cds.db.options.credentials.user)
    // attributeMap.set(SemanticAttributes.DB_CONNECTION_STRING, cds.db.options) // TODO: clarify what the value should be
    attributeMap.set(SemanticAttributes.NET_PEER_NAME, cds.env.requires.db.credentials.host)
    attributeMap.set(SemanticAttributes.NET_PEER_PORT, cds.env.requires.db.credentials.port)
    // attributeMap.set(SemanticAttributes.NET_TRANSPORT, cds.db.options) // TODO: clarify what value
    attributeMap.set(SemanticAttributes.DB_SQL_TABLE, targetObj.context?.entity || name?.path)
    attributeMap.set(SemanticAttributes.DB_OPERATION, name?.event)
  }
  if (targetObj.constructor.name === 'cds' || name?.phase === 'emit') {
    // cds for cds.spawn - emit for srv.emit
    attributeMap.set('sap.cds.async', true)
  }

  updateAttributeMapBasedOnRequestType(args, attributeMap)
  const getParent = () => {
    if (!cds.context._otelctx) {
      cds.context._otelKey = otelCreateContextKey(cds.context.id)
      cds.context._otelctx = otelContextAPI.active()
      const parent = otelTrace.getSpan(otelContextAPI.active())
      if (!parent?.attributes['sap.cds.async']) {
        cds.context._otelctx.setValue(cds.context._otelKey, parent)
      }
    }
    return otelContextAPI.active().getValue(cds.context._otelKey) || cds.context._otelctx.getValue(cds.context._otelKey)
  }
  const parentSpan = getParent(),
    isAsyncCall = parentSpan?.attributes['sap.cds.async']
  const ctx = isAsyncCall
    ? ROOT_CONTEXT
    : parentSpan
    ? otelTrace.setSpan(otelContextAPI.active(), parentSpan)
    : otelContextAPI.active()
  const spanOptions = {
    /* attributes: {
          // Attributes from the HTTP trace semantic conventions
          // https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/semantic_conventions/http.md
          [SemanticAttributes.HTTP_METHOD]: "GET",
  
        } */
    kind: determineKind(targetObj, name?.phase, isAsyncCall, options)
  }
  if (options.outbound) {
    attributeMap.set('sap.btp.destination', options.outbound)
  }
  if (isAsyncCall) {
    spanOptions.links = [{ context: parentSpan.spanContext() }]
    spanOptions.parent = undefined
  }
  const span = cds.env.requires.otel.trace.tracer.startSpan(spanName, spanOptions, ctx)
  attributeMap.forEach((value, key) => {
    span.setAttribute(key, value)
  })

  return getResult()

  function getResult() {
    return otelContextAPI.with(
      // otelTrace.setSpan(ctx, span),
      cds.context._otelctx.setValue(cds.context._otelKey, span),
      fnToExecute()
    )
  }
  function fnToExecute() {
    if (func.constructor.name === 'AsyncFunction')
      return async () => {
        let methodResult
        try {
          methodResult = await func.apply(targetObj, args)
          span.setStatus({ code: SpanStatusCode.OK })
        } catch (e) {
          span.recordException(e)
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
          throw e
        } finally {
          span.end()
        }
        return methodResult
      }
    else
      return () => {
        let methodResult
        try {
          methodResult = func.apply(targetObj, args)
          span.setStatus({ code: SpanStatusCode.OK })
        } catch (e) {
          span.recordException(e)
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
          throw e
        } finally {
          span.end()
        }
        return methodResult
      }
  }
}

function updateAttributeMapBasedOnRequestType(args, attributeMap) {
  if (Array.isArray(args) && args.length > 0) {
    switch (args[0].constructor.name) {
      case 'Request':
        updateAttributeMap(attributeMap, args[0].context)
        break
      case 'ODataRequest':
        updateAttributeMap(attributeMap, args[0])
        break
      default:
        break
    }
  }
}

function getDBTarget(targetObj) {
  if (targetObj.context?.target?.projection?.from?.ref[0]) return targetObj.context?.target?.projection?.from?.ref[0]
  else if (targetObj._propagated) return getDBTarget(targetObj._propagated)
  else if (targetObj?.context?._propagated) return getDBTarget(targetObj.context._propagated)
  else return null
}

function getSpanName({ phase, event }, func, attributeMap, targetObj) {
  if (targetObj.dbc) {
    // DB name -- Guidelines: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/semantic_conventions/database.md
    //<db.operation> <db.name>.<db.sql.table> or <db.operation> <db.name> or db.name
    // db.name = targetObj.dbc.filename, db.operation = event, db.operation = targetObj.context.query - INSERT.into, SELECT.from, DELETE.from, UPDATE.entity
    return (
      `${event ? event + ' ' : ''} ` +
      `${targetObj.dbc.filename || (targetObj.dbc.name in { hdb: 1, 'hana-client': 1 } ? `HANA` : 'db')}` +
      `${!(event in { BEGINN: 1, COMMIT: 1 }) && getDBTarget(targetObj) ? '."' + getDBTarget(targetObj) + '"' : ''}`
    )
  }
  if (func.name && targetObj.constructor.name !== 'OData') {
    attributeMap.set(SemanticAttributes.CODE_FUNCTION, func.name)
    return `${targetObj.constructor.name}::${func.name}::${phase ? `${phase}::` : ''}${event}`
  } else {
    return `${targetObj.constructor.name}::${phase}-${event}`
  }
}

function updateAttributeMap(attributeMap, arg) {
  attributeMap.set('sap.cds.entity', arg.entity)
}

function determineKind(targetObj, phase, isAsyncConsumer, options) {
  // DB Calls & Remote calls are client calls
  if (targetObj.dbc || targetObj.constructor.name === 'RemoteService' || options.outbound) return SpanKind.CLIENT
  if (targetObj.constructor.name === 'cds' || phase === 'emit')
    // cds.spawn or srv.emit
    return SpanKind.PRODUCER
  if (isAsyncConsumer) return SpanKind.CONSUMER
  return SpanKind.INTERNAL
}
