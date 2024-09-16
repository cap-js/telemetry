const cds = require('@sap/cds')

const otel = require('@opentelemetry/api')
const { SpanKind, SpanStatusCode, ROOT_CONTEXT } = otel
const {
  SEMATTRS_HTTP_HOST,
  SEMATTRS_HTTP_URL,
  SEMATTRS_HTTP_SCHEME,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_CODE_FUNCTION,
  SEMATTRS_CODE_FILEPATH,
  SEMATTRS_CODE_NAMESPACE,
  SEMATTRS_CODE_LINENO,
  // SEMATTRS_CODE_COLUMN,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_USER,
  SEMATTRS_DB_CONNECTION_STRING,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_OPERATION,
  SEMATTRS_DB_SQL_TABLE
} = require('@opentelemetry/semantic-conventions')
// REVISIT: SEMATTRS_CODE_COLUMN doesn't yet exist in semantic conventions 1.25
const SEMATTRS_CODE_COLUMN = 'code.column'

const sapdsrpassport = require('@sap/sapdsrpassport')
const dsrpassport = new sapdsrpassport.DsrPassport()
const Tools = require('@sap/sapdsrpassport/dist/util/Tools')
const CompTypes = require('@sap/sapdsrpassport/dist/model/ComponentTypes')
const TFlags = require('@sap/sapdsrpassport/dist/model/TraceFlags')

const { _hrnow } = require('../utils')

const DB_KINDS = {
  hana: 'hanadb'
}

const MASK_HEADERS = (cds.env.log.mask_headers || ['/authorization/i', '/cookie/i']).map(s => {
  const parts = s.match(/\/(.+)\/(\w*)/)
  if (parts) return new RegExp(parts[1], parts[2])
  return new RegExp(s)
})

const { hrtime, adjust_root_name, _truncate_span_name } = cds.env.requires.telemetry.tracing
const HRTIME = hrtime && hrtime !== 'false'
const ADJUST_ROOT_NAME = adjust_root_name && adjust_root_name !== 'false'

// attach a hr time to incoming requests for later adjustment of span start time in _getParentSpan()
if (HRTIME) cds.on('listening', ({ server }) => server.on('request', req => (req.__hrnow = _hrnow())))

function _getParentSpan() {
  if (!cds.context) return
  if (!cds.context._otelctx) {
    cds.context._otelKey = otel.createContextKey(cds.context.id)
    cds.context._otelctx = otel.context.active()
    const parent = otel.trace.getSpan(cds.context._otelctx)
    if (parent && !parent.__adjusted) {
      parent.__adjusted = true
      // root span gets request attributes
      _setAttributes(parent, _getRequestAttributes())
      if (HRTIME) parent.startTime = cds.context.http?.req?.__hrnow || _hrnow()
      if (ADJUST_ROOT_NAME && parent.attributes[SEMATTRS_HTTP_TARGET])
        parent.name += ' ' + parent.attributes[SEMATTRS_HTTP_TARGET]
    }
    if (!parent?._is_async) cds.context._otelctx.setValue(cds.context._otelKey, parent)
  }
  return otel.context.active().getValue(cds.context._otelKey) || cds.context._otelctx.getValue(cds.context._otelKey)
}

function _getSpanName(arg, fn, targetObj) {
  const { phase, event, path } = arg

  if (targetObj.dbc) {
    if (event === undefined) return `db - ${arg.query}`
    return `db - ${event}${!(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) ? ` ${arg.target?.name || arg.path}` : ''}`
  }

  if (fn.name && targetObj.constructor.name !== 'OData') {
    if (phase) return `${targetObj.name}.${fn.name} - ${phase} - ${event}${path ? ` ${path}` : ''}`
    if (targetObj.name) return `${targetObj.name} - ${event}${path ? ` ${path}` : ''}`
    return `${event}${path ? ` ${path}` : ''}`
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

    if (fn.name) attributes.set(SEMATTRS_CODE_FUNCTION, fn.name)

    if (fn.__location) {
      const location = fn.__location
      const path = location.url.replace('file://', '')
      attributes.set(SEMATTRS_CODE_FILEPATH, path)
      const namespace = path.match(/\/node_modules\//) ? path.split('/node_modules/')[1] : path
      attributes.set(SEMATTRS_CODE_NAMESPACE, namespace)
      attributes.set(SEMATTRS_CODE_LINENO, location.line)
      attributes.set(SEMATTRS_CODE_COLUMN, location.column)
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

    attributes.set(SEMATTRS_HTTP_HOST, req.headers.host)
    attributes.set('server.address', req.headers.host)

    const full = req.protocol + '://' + req.headers.host + req.url
    attributes.set(SEMATTRS_HTTP_URL, full)
    attributes.set('url.full', full)

    attributes.set(SEMATTRS_HTTP_SCHEME, req.protocol)
    attributes.set('url.scheme', req.protocol)

    attributes.set(SEMATTRS_HTTP_TARGET, req.url)
    const [path, query] = req.url.split('?')
    attributes.set('url.path', path)
    if (query) attributes.set('url.query', query)

    attributes.set(SEMATTRS_HTTP_METHOD, req.method)
    attributes.set('http.request.method', req.method)

    for (const [key, value] of Object.entries(cds.context.http.req.headers || {})) {
      if (MASK_HEADERS.some(m => key.match(m))) attributes.set(`http.request.header.${key}`, '***')
      else attributes.set(`http.request.header.${key}`, value.split(';'))
    }

    cds.context.http.req.__attributes = attributes
  }

  return cds.context.http.req.__attributes
}

function _getStaticDBAttributes(tenant = '', creds) {
  if (!module.exports.__dbAttributes) module.exports.__dbAttributes = new Map()
  if (!module.exports.__dbAttributes.has(tenant)) {
    const attributes = new Map()
    attributes.set(SEMATTRS_DB_SYSTEM, DB_KINDS[cds.db.options.kind] || cds.db.options.kind)
    attributes.set(SEMATTRS_DB_NAME, cds.db.vcap?.name || cds.db.name)
    attributes.set(SEMATTRS_DB_USER, creds ? creds.user : cds.db.options.credentials.user)
    attributes.set(SEMATTRS_DB_CONNECTION_STRING, creds ? creds.url : cds.db.options.credentials.url)
    attributes.set(SEMATTRS_NET_PEER_NAME, creds ? creds.host : cds.env.requires.db.credentials.host)
    attributes.set(SEMATTRS_NET_PEER_PORT, creds ? creds.port : cds.env.requires.db.credentials.port)
    module.exports.__dbAttributes.set(tenant, attributes)
  }
  return module.exports.__dbAttributes.get(tenant)
}

function _getDynamicDBAttributes(options, args, parentSpan) {
  // NOTE: cds.run(query) comes through here multiple times.
  //       the first time, args has event, target, and sometimes a string query.
  //       the second time, args is the string query -> we need to get event and target from the previous invocation (i.e., parentSpan).
  const dbAttributes = new Map()
  const db_statement =
    options.sql || (typeof args[0].query === 'string' && args[0].query) || (typeof args[0] === 'string' && args[0])
  if (db_statement) dbAttributes.set(SEMATTRS_DB_STATEMENT, db_statement)
  const db_operation = args[0].event || parentSpan?.attributes[SEMATTRS_DB_OPERATION]
  if (db_operation) dbAttributes.set(SEMATTRS_DB_OPERATION, db_operation)
  const db_sql_table = args[0].target?.name || parentSpan?.attributes[SEMATTRS_DB_SQL_TABLE]
  if (db_sql_table) dbAttributes.set(SEMATTRS_DB_SQL_TABLE, db_sql_table)
  return dbAttributes
}

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
  // needed for sampling decision (cf. shouldSample)
  if (cds.context?.http?.req) spanOptions.attributes = { 'http.originalUrl': cds.context.http?.req.originalUrl }
  if (HRTIME) spanOptions.startTime = _hrnow()
  if (isAsync) {
    spanOptions.links = [{ context: parentSpan.spanContext() }]
    spanOptions.parent = undefined
  }
  let spanName = typeof name === 'string' ? name : _getSpanName(name, fn, targetObj)
  if (spanName.length > 80 && _truncate_span_name !== false) spanName = spanName.substring(0, 79) + '…'
  // REVISIT: better way to get tracer?
  const span = cds._telemetry.tracer.startSpan(spanName, spanOptions, ctx)
  if (name.event?.match(/^cds\.spawn/) || name?.phase === 'emit') span._is_async = true

  // REVISIT: can we determine this earlier?
  // if the current request matches instrumentation-http's ignoreIncomingPaths, we get a NonRecordingSpan -> abort
  if (span.constructor.name === 'NonRecordingSpan') return fn.apply(targetObj, args)

  /*
   * set attributes on span
   */
  _setAttributes(span, _getStaticAttributes(fn))

  if (targetObj.dbc || options.sql) {
    //> NOTE: !targetObj.dbc is the case during execution of a prepared statement

    if (cds.requires.multitenancy) {
      const creds = targetObj?.dbc?._connection?._settings || targetObj?.dbc?._creds //> hdb vs. @sap/hana-client
      _setAttributes(span, _getStaticDBAttributes(cds.context?.tenant, creds))
    } else {
      _setAttributes(span, _getStaticDBAttributes())
    }

    _setAttributes(span, _getDynamicDBAttributes(options, args, parentSpan))

    // SAP Passport
    if (targetObj.dbc?.constructor.name in { HDBDriver: 1, HANAClientDriver: 1 }) {
      const { spanId, traceFlags, traceId, traceState } = span._spanContext
      debugger
      // prettier-ignore
      const sap_passport_1 = dsrpassport.createV3Passport(
        TFlags.TraceFlags.LOW,             // (NONE|LOW|MEDIUM|HIGH) Use LOW for just correlation
        "DemoComponent_1",                 // Passport Creator ComponentName
        0,                                 // Service: 0 for "undefined"
        "<dummy>",                         // 
        "action",                          //
        11,                                // ActionType: 11 denotes HTTP Request
        "DemoComponent_1",                 // Previous Component PreviousComponentName
        Tools.Tools.createGUID(16),        // TransactionID 
        "   ",                             // In case of ABAP system Source Client, else "   "
        CompTypes.ComponentTypes.TRACELIB, // Corresponding Component Type (see ComponentTypes)
        Tools.Tools.createGUID(16),        // RootContextId
        Tools.Tools.createGUID(16),        // ConnectionId  
        1                                  // ConnectionCounter
      )
      const sap_passport_2 = dsrpassport.getPassportAsString()
      targetObj.dbc.set({ SAP_PASSPORT: sap_passport })
    }

    // augment db.statement at parent, if necessary
    if (
      span.attributes[SEMATTRS_DB_STATEMENT] &&
      parentSpan?.attributes[SEMATTRS_DB_SYSTEM] &&
      !parentSpan.attributes[SEMATTRS_DB_STATEMENT]
    ) {
      parentSpan.setAttribute(SEMATTRS_DB_STATEMENT, span.attributes[SEMATTRS_DB_STATEMENT])
    }
  }

  const otherAttributes = new Map()
  if (cds.context?.tenant) otherAttributes.set('sap.tenancy.tenant_id', cds.context.tenant)
  if (options.outbound) otherAttributes.set('sap.btp.destination', options.outbound)
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
      if (span.status.code !== SpanStatusCode.UNSET && !span.ended) span.end(HRTIME ? _hrnow() : undefined)
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
