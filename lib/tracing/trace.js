const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const otel = require('@opentelemetry/api')
const { SpanKind, SpanStatusCode, ROOT_CONTEXT } = otel
const {
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_URL_SCHEME,
  ATTR_URL_PATH,
  ATTR_URL_QUERY,
  ATTR_HTTP_REQUEST_METHOD,
  SEMATTRS_CODE_FUNCTION: ATTR_CODE_FUNCTION,
  SEMATTRS_CODE_FILEPATH: ATTR_CODE_FILEPATH,
  SEMATTRS_CODE_NAMESPACE: ATTR_CODE_NAMESPACE,
  SEMATTRS_CODE_LINENO: ATTR_CODE_LINENO,
  // ATTR_CODE_COLUMN,
  SEMATTRS_DB_SYSTEM: ATTR_DB_SYSTEM,
  SEMATTRS_DB_NAME: ATTR_DB_NAME,
  SEMATTRS_DB_USER: ATTR_DB_USER,
  SEMATTRS_DB_CONNECTION_STRING: ATTR_DB_CONNECTION_STRING,
  SEMATTRS_DB_STATEMENT: ATTR_DB_STATEMENT,
  SEMATTRS_DB_OPERATION: ATTR_DB_OPERATION,
  SEMATTRS_DB_SQL_TABLE: ATTR_DB_SQL_TABLE,
  ATTR_CLIENT_ADDRESS,
  ATTR_CLIENT_PORT
} = require('@opentelemetry/semantic-conventions')
// REVISIT: ATTR_CODE_COLUMN doesn't yet exist in semantic conventions 1.27
const ATTR_CODE_COLUMN = 'code.column'

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
      if (ADJUST_ROOT_NAME && parent.attributes[ATTR_URL_PATH]) parent.name += ' ' + parent.attributes[ATTR_URL_PATH]
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

    if (fn.name) attributes.set(ATTR_CODE_FUNCTION, fn.name)

    if (fn.__location) {
      const location = fn.__location
      const path = location.url.replace('file://', '')
      attributes.set(ATTR_CODE_FILEPATH, path)
      const namespace = path.match(/\/node_modules\//) ? path.split('/node_modules/')[1] : path
      attributes.set(ATTR_CODE_NAMESPACE, namespace)
      attributes.set(ATTR_CODE_LINENO, location.line)
      attributes.set(ATTR_CODE_COLUMN, location.column)
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

    attributes.set(ATTR_SERVER_ADDRESS, req.headers.host)
    const full = req.protocol + '://' + req.headers.host + req.url
    attributes.set(ATTR_URL_FULL, full)
    attributes.set(ATTR_URL_SCHEME, req.protocol)
    const [path, query] = req.url.split('?')
    attributes.set(ATTR_URL_PATH, path)
    if (query) attributes.set(ATTR_URL_QUERY, query)
    attributes.set(ATTR_HTTP_REQUEST_METHOD, req.method)
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
    attributes.set(ATTR_DB_SYSTEM, DB_KINDS[cds.db.options.kind] || cds.db.options.kind)
    attributes.set(ATTR_DB_NAME, cds.db.vcap?.name || cds.db.name)
    attributes.set(ATTR_DB_USER, creds ? creds.user : cds.db.options.credentials.user)
    attributes.set(ATTR_DB_CONNECTION_STRING, creds ? creds.url : cds.db.options.credentials.url)
    attributes.set(ATTR_CLIENT_ADDRESS, creds ? creds.host : cds.env.requires.db.credentials.host)
    attributes.set(ATTR_CLIENT_PORT, creds ? creds.port : cds.env.requires.db.credentials.port)
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
  if (db_statement) dbAttributes.set(ATTR_DB_STATEMENT, db_statement)
  const db_operation = args[0].event || parentSpan?.attributes[ATTR_DB_OPERATION]
  if (db_operation) dbAttributes.set(ATTR_DB_OPERATION, db_operation)
  const db_sql_table = args[0].target?.name || parentSpan?.attributes[ATTR_DB_SQL_TABLE]
  if (db_sql_table) dbAttributes.set(ATTR_DB_SQL_TABLE, db_sql_table)
  return dbAttributes
}

function _setAttributes(span, attributes) {
  if (!attributes || !(attributes instanceof Map)) return
  attributes.forEach((value, key) => span.setAttribute(key, value))
}

const _addDbRowCount = (span, res) => {
  if (!span.attributes['db.statement'] || !['all', 'run'].includes(span.attributes['code.function'])) return

  let rowCount
  switch (span.attributes['db.operation']) {
    case 'DELETE':
    case 'UPDATE':
    case 'CREATE':
      rowCount = res.changes
      break
    case 'READ':
      rowCount = res.length ?? 1
  }
  if (rowCount != null) span.setAttribute('db.client.response.returned_rows', rowCount)
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
  if (cds.context?.http?.req) {
    const url_path = cds.context.http.req.baseUrl + cds.context.http.req.path
    spanOptions.attributes = {
      'url.path': url_path,
      'http.target': url_path //> http.target is deprecated
    }
  }
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
    if (process.env.SAP_PASSPORT && targetObj.dbc?.constructor.name in { HDBDriver: 1, HANAClientDriver: 1 }) {
      const { spanId, traceId } = span.spanContext()
      // prettier-ignore
      let passport = [
        /* EYECATCHER      */ '2A54482A',
        /* VERSION         */ '03',
        /* LENGTH          */ '00E6',
        /* TRACELEVEL      */ '0000',
        /* COMPONENTID     */ '2020202020202020202020202020202020202020202020202020202020202020',
        /* SERVICE         */ '0000',
        /* USER            */ '2020202020202020202020202020202020202020202020202020202020202020',
        /* ACTION          */ '20202020202020202020202020202020202020202020202020202020202020202020202020202020',
        /* ACTIONTYPE      */ '0000',
        /* PREVCOMPONENTID */ Buffer.from(span.resource.attributes['service.name'].substr(0, 32).padEnd(32, ' ')).toString('hex'),
        /* TRANSACTIONID   */ Buffer.from(traceId.toUpperCase()).toString('hex'),
        /* CLIENT          */ '202020',
        /* COMPONENTTYPE   */ '0000',
        /* ROOTCONTEXTID   */ traceId.toUpperCase(),
        /* CONNECTIONID    */ '0000000000000001' + spanId.toUpperCase(),
        /* CONNECTIONCNT   */ '00000001',
        /* VARPARTCOUNT    */ '0000',
        /* VARPARTOFFSET   */ '0000', // REVISIT: @sap/dsrpassport uses '0226'
        /* EYECATCHER      */ '2A54482A'
      ]
      passport = passport.join('')
      LOG._debug && LOG.debug('Setting SAP Passport:', passport)
      targetObj.dbc.set({ SAP_PASSPORT: passport })
    }

    // augment db.statement at parent, if necessary
    if (
      span.attributes[ATTR_DB_STATEMENT] &&
      parentSpan?.attributes[ATTR_DB_SYSTEM] &&
      !parentSpan.attributes[ATTR_DB_STATEMENT]
    ) {
      parentSpan.setAttribute(ATTR_DB_STATEMENT, span.attributes[ATTR_DB_STATEMENT])
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
      _addDbRowCount(span, res)
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
