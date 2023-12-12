const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const locate = require('./locate')

const otel = require('@opentelemetry/api')
const { SpanKind, SpanStatusCode, ROOT_CONTEXT } = otel
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')

function _updateAttributeMapBasedOnRequestType(args, attributeMap) {
  if (Array.isArray(args) && args.length > 0) {
    switch (args[0].constructor.name) {
      case 'Request':
        attributeMap.set('sap.cds.entity', args[0].context.entity)
        break
      case 'ODataRequest':
        attributeMap.set('sap.cds.entity', args[0].entity)
        break
      default:
        break
    }
  }
}

function _getParentSpan() {
  if (!cds.context._otelctx) {
    cds.context._otelKey = otel.createContextKey(cds.context.id)
    cds.context._otelctx = otel.context.active()
    const parent = otel.trace.getSpan(cds.context._otelctx)
    if (parent && !parent.__adjusted) {
      parent.startTime = process.hrtime()
      parent.__adjusted = true
    }
    if (!parent?.attributes?.['sap.cds.async']) {
      cds.context._otelctx.setValue(cds.context._otelKey, parent)
    }
  }
  return otel.context.active().getValue(cds.context._otelKey) || cds.context._otelctx.getValue(cds.context._otelKey)
}

function _getDBTarget(targetObj) {
  if (targetObj.context?.target?.projection?.from?.ref[0]) return targetObj.context?.target?.projection?.from?.ref[0]
  else if (targetObj._propagated) return _getDBTarget(targetObj._propagated)
  else if (targetObj?.context?._propagated) return _getDBTarget(targetObj.context._propagated)
  else return null
}

function _getSpanName(arg, func, attributeMap, targetObj) {
  const { phase, event, path } = arg

  if (targetObj.dbc) {
    // DB name -- Guidelines: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/semantic_conventions/database.md
    // <db.operation> <db.name>.<db.sql.table> or <db.operation> <db.name> or db.name
    // db.name = targetObj.dbc.filename, db.operation = event, db.operation = targetObj.context.query - INSERT.into, SELECT.from, DELETE.from, UPDATE.entity
    // return (
    //   `${event ? event + ' ' : ''}` +
    //   `${targetObj.dbc.filename || (targetObj.dbc.name in { hdb: 1, 'hana-client': 1 } ? `HANA` : 'db')}` +
    //   `${
    //     !(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) && _getDBTarget(targetObj)
    //       ? '."' + _getDBTarget(targetObj) + '"'
    //       : ''
    //   }`
    // )
    const t = _getDBTarget(targetObj)
    // return `${targetObj.dbc?.name || 'db'} - ${event}${!(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) ? ` ${t}` : ''}`
    return `db - ${event}${!(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) ? ` ${t}` : ''}`
  }

  if (func.name && targetObj.constructor.name !== 'OData') {
    attributeMap.set(SemanticAttributes.CODE_FUNCTION, func.name)
    if (phase) return `${targetObj.name}.${func.name} - ${phase} - ${event}${path ? ` ${path}` : ''}`
    return `${targetObj.name} - ${event}${path ? ` ${path}` : ''}`
  }

  return `${targetObj.name} - ${phase} - ${event}${path ? ` ${path}` : ' *'}`
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

/**
 * @param {string|object} name
 * @param {*} fn
 * @param {*} targetObj
 * @param {*} args
 * @param {String} options.loggerName
 * @param {String} options.outbound Name of BTP destination
 * @returns
 */
module.exports = async function trace(name, fn, targetObj, args, options = {}) {
  const attributeMap = new Map()

  // REVISIT: what is this for?
  attributeMap.set('sap.cds.logger', options.loggerName || LOG.label)

  const location = await locate(fn)
  if (location) {
    const path = location.url.replace('file://', '')
    attributeMap.set(SemanticAttributes.CODE_FILEPATH, path)
    const namespace = path.match(/\/node_modules\//) ? path.split('/node_modules/')[1] : path
    attributeMap.set(SemanticAttributes.CODE_NAMESPACE, namespace)
    attributeMap.set(SemanticAttributes.CODE_LINENO, location.line)
    // REVISIT: SemanticAttributes.CODE_COLUMN did not yet exists when programming
    attributeMap.set('code.column', location.column)
  }

  if (cds.context?.http?.headers) {
    // REVISIT: 'http.correlation-id' or 'http.correlation_id'?
    attributeMap.set('http.correlation-id', cds.context.http.headers['x-correlation-id'])
  }
  if (cds.context?.tenant) {
    // https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/tenancy.md#sap-tenancy-related-otel-attributes
    attributeMap.set('sap.tenancy.tenant_id', cds.context.tenant)
  }

  // REVISIT: correct?
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

  // REVISIT: correct?
  if (targetObj.constructor.name === 'cds' || name?.phase === 'emit') {
    // cds for cds.spawn - emit for srv.emit
    attributeMap.set('sap.cds.async', true)
  }

  _updateAttributeMapBasedOnRequestType(args, attributeMap)

  const parentSpan = _getParentSpan()
  const isAsyncCall = parentSpan?.attributes?.['sap.cds.async']
  const ctx = isAsyncCall
    ? ROOT_CONTEXT
    : parentSpan
    ? otel.trace.setSpan(otel.context.active(), parentSpan)
    : otel.context.active()
  const spanOptions = {
    /*
    attributes: {
      // Attributes from the HTTP trace semantic conventions
      // https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/semantic_conventions/http.md
      [SemanticAttributes.HTTP_METHOD]: "GET",
    }
    */
    kind: _determineKind(targetObj, name?.phase, isAsyncCall, options),
    startTime: process.hrtime()
  }

  if (options.outbound) {
    attributeMap.set('sap.btp.destination', options.outbound)
  }

  if (isAsyncCall) {
    spanOptions.links = [{ context: parentSpan.spanContext() }]
    spanOptions.parent = undefined
  }

  // REVISIT: better way to get tracer?
  const spanName = typeof name === 'string' ? name : _getSpanName(name, fn, attributeMap, targetObj)
  const span = cds._telemetry.tracer.startSpan(spanName, spanOptions, ctx)
  attributeMap.forEach((value, key) => {
    span.setAttribute(key, value)
  })

  function getResult() {
    return otel.context.with(
      // otelTrace.setSpan(ctx, span),
      cds.context._otelctx.setValue(cds.context._otelKey, span),
      fnToExecute()
    )
  }

  function fnToExecute() {
    // if (fn.constructor.name === 'AsyncFunction') {
    //   return async () => {
    //     let methodResult
    //     try {
    //       methodResult = await fn.apply(targetObj, args)
    //       span.setStatus({ code: SpanStatusCode.OK })
    //     } catch (e) {
    //       span.recordException(e)
    //       span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
    //       throw e
    //     } finally {
    //       span.end(process.hrtime())
    //     }
    //     return methodResult
    //   }
    // } else {
    //   return () => {
    //     let methodResult
    //     try {
    //       methodResult = fn.apply(targetObj, args)
    //       span.setStatus({ code: SpanStatusCode.OK })
    //     } catch (e) {
    //       span.recordException(e)
    //       span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
    //       throw e
    //     } finally {
    //       span.end(process.hrtime())
    //     }
    //     return methodResult
    //   }
    // }
    
    return () => {
      let methodResult, isAsync
      try {
        methodResult = fn.apply(targetObj, args)
        isAsync = methodResult instanceof Promise
        if (isAsync) {
          methodResult.then(res => {
            span.setStatus({ code: SpanStatusCode.OK })
            return res
          }).catch(e => {
            span.recordException(e)
            span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
            throw e
          }).finally(() => {
            span.end(process.hrtime())
          })
        } else {
          span.setStatus({ code: SpanStatusCode.OK })
        }
      } catch (e) {
        span.recordException(e)
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
        throw e
      } finally {
        !isAsync && span.end(process.hrtime())
      }
      return methodResult
    }
  }

  return getResult()
}
