const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const otel = require('@opentelemetry/api')
const { SpanKind, SpanStatusCode } = otel
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_SCHEME,
  ATTR_URL_PATH,
  ATTR_URL_QUERY,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_CODE_FUNCTION_NAME,
  ATTR_CODE_FILE_PATH,
  SEMATTRS_CODE_NAMESPACE: ATTR_CODE_NAMESPACE,
  ATTR_CODE_LINE_NUMBER,
  ATTR_CODE_COLUMN_NUMBER,
  // ATTR_CODE_COLUMN,
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_NAMESPACE,
  SEMATTRS_DB_USER: ATTR_DB_USER,
  SEMATTRS_DB_CONNECTION_STRING: ATTR_DB_CONNECTION_STRING,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_OPERATION_NAME,
  SEMATTRS_DB_SQL_TABLE: ATTR_DB_SQL_TABLE
} = require('@opentelemetry/semantic-conventions')

const { _hrnow } = require('../utils')

const DB_KINDS = {
  hana: 'sap.hana'
}

const MASK_HEADERS = (cds.env.log.mask_headers || ['/authorization/i', '/cookie/i']).map(s => {
  const parts = s.match(/\/(.+)\/(\w*)/)
  if (parts) return new RegExp(parts[1], parts[2])
  return new RegExp(s)
})

const CRUD = { CREATE: 1, READ: 1, UPDATE: 1, DELETE: 1 }

const { hrtime, adjust_root_name, _truncate_span_name } = cds.env.requires.telemetry.tracing
const HRTIME = hrtime && hrtime !== 'false'
const ADJUST_ROOT_NAME = adjust_root_name && adjust_root_name !== 'false'

const $hrnow = Symbol('@cap-js/telemetry:hrnow')
const $adjusted = Symbol('@cap-js/telemetry:adjusted')
const $reqattrs = Symbol('@cap-js/telemetry:reqattrs')

let tracer
cds.on('served', () => {
  tracer = otel.trace.getTracer('@cap-js/telemetry', require('../../package.json').version)

  if (HRTIME) {
    // monkey patch startActiveSpan to set a hr time as startTime (if none was provided)
    const { startActiveSpan } = tracer
    tracer.startActiveSpan = function (name, options, fn) {
      options.startTime ??= _hrnow()
      return startActiveSpan.call(this, name, options, fn)
    }

    // attach a hr time to incoming requests for later adjustment of the root span start time
    cds.on('listening', ({ server }) => server.on('request', req => (req[$hrnow] = _hrnow())))
  }
})

// REVISIT: needs a cleanup
function _getSpanName(arg, fn, that) {
  const { phase, event, path } = arg

  if (that.dbc) {
    if (event === undefined) return `db - ${arg.query}`
    return `db - ${event}${!(event in { BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }) ? ` ${arg.target?.name || arg.path}` : ''}`
  }

  if (fn.name && that.constructor.name !== 'OData') {
    if (phase) return `${that.name} - ${phase} ${event}${path ? ` ${path}` : ''}`
    if (that.name) return `${that.name} - ${event in CRUD ? event : `handle ${event}`}${path ? ` ${path}` : ''}`
    return `${event}${path ? ` ${path}` : ''}`
  }

  const trgt = that.name ? `${that.name} - ` : ''
  const phs = phase ? `${phase} - ` : ''
  const pth = event.match(/cds\.spawn/) ? '' : path ? ` ${path}` : ' *'
  return `${trgt}${phs}${event}${pth}`
}

function _getStaticAttributes(fn, options) {
  if (!fn[$reqattrs]) {
    const attributes = new Map()

    if (fn.name) {
      attributes.set(ATTR_CODE_FUNCTION_NAME, fn.name)
    } else if (options?.fn) {
      // REVISIT: case _hana_prom = true
      attributes.set(ATTR_CODE_FUNCTION_NAME, options?.fn)
    }

    if (fn.__location) {
      const location = fn.__location
      const path = location.url.replace('file://', '')
      attributes.set(ATTR_CODE_FILE_PATH, path)
      const namespace = path.match(/\/node_modules\//) ? path.split('/node_modules/')[1] : path
      attributes.set(ATTR_CODE_NAMESPACE, namespace)
      attributes.set(ATTR_CODE_LINE_NUMBER, location.line)
      attributes.set(ATTR_CODE_COLUMN_NUMBER, location.column)
    }

    const VCAP_APPLICATION = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)
    if (VCAP_APPLICATION) {
      attributes.set('server.port', VCAP_APPLICATION.port)
    }

    fn[$reqattrs] = attributes
  }

  return fn[$reqattrs]
}

function _getRequestAttributes() {
  const ctx = cds.context

  if (!ctx?.http?.req) return

  if (!ctx.http.req[$reqattrs]) {
    const req = ctx.http.req

    const attributes = new Map()

    attributes.set(ATTR_SERVER_ADDRESS, req.headers.host)
    const full = req.protocol + '://' + req.headers.host + req.url
    attributes.set(ATTR_URL_FULL, full)
    attributes.set(ATTR_URL_SCHEME, req.protocol)
    const [path, query] = req.url.split('?')
    attributes.set(ATTR_URL_PATH, path)
    if (query) attributes.set(ATTR_URL_QUERY, query)
    attributes.set(ATTR_HTTP_REQUEST_METHOD, req.method)
    for (const [key, value] of Object.entries(ctx.http.req.headers || {})) {
      if (MASK_HEADERS.some(m => key.match(m))) attributes.set(`http.request.header.${key}`, '***')
      else attributes.set(`http.request.header.${key}`, value?.split(';') ?? 'undefined') //> there have been reports of undefined header values in production -> please keep!
    }

    ctx.http.req[$reqattrs] = attributes
  }

  return ctx.http.req[$reqattrs]
}

function _getStaticDBAttributes(tenant = '', creds) {
  creds ??= cds.env.requires.db.credentials
  if (!module.exports.__dbAttributes) module.exports.__dbAttributes = new Map()
  if (!module.exports.__dbAttributes.has(tenant)) {
    const attributes = new Map()
    attributes.set(ATTR_DB_SYSTEM_NAME, DB_KINDS[cds.db.options.kind] || cds.db.options.kind)
    attributes.set(ATTR_DB_NAMESPACE, cds.db.vcap?.name || cds.db.name)
    attributes.set(ATTR_DB_USER, creds.user)
    attributes.set(ATTR_DB_CONNECTION_STRING, creds.url)
    attributes.set(ATTR_SERVER_ADDRESS, creds.host)
    attributes.set(ATTR_SERVER_PORT, creds.port)
    module.exports.__dbAttributes.set(tenant, attributes)
  }
  return module.exports.__dbAttributes.get(tenant)
}

function _getDynamicDBAttributes(options, args, parent) {
  // NOTE: cds.run(query) comes through here multiple times.
  //       the first time, args has event, target, and sometimes a string query.
  //       the second time, args is the string query -> we need to get event and target from the previous invocation (i.e., parentSpan).
  const dbAttributes = new Map()
  const db_statement =
    options.sql ||
    (typeof args[0]?.query === 'string' && args[0].query) ||
    (typeof args[0] === 'string' && args[0]) ||
    parent?.attributes[ATTR_DB_QUERY_TEXT]
  if (db_statement) dbAttributes.set(ATTR_DB_QUERY_TEXT, db_statement)
  const db_operation = args[0]?.event || parent?.attributes[ATTR_DB_OPERATION_NAME]
  if (db_operation) dbAttributes.set(ATTR_DB_OPERATION_NAME, db_operation)
  const db_sql_table = args[0]?.target?.name || parent?.attributes[ATTR_DB_SQL_TABLE]
  if (db_sql_table) dbAttributes.set(ATTR_DB_SQL_TABLE, db_sql_table)
  return dbAttributes
}

function _setAttributes(span, attributes) {
  if (!attributes || !(attributes instanceof Map)) return
  attributes.forEach((value, key) => span.setAttribute(key, value))
}

function _addAttributes(span, fn, that, options, args, parent) {
  _setAttributes(span, _getStaticAttributes(fn, options))

  const ctx = cds.context

  // needed for sampling decision (cf. shouldSample)
  if (ctx?.http?.req) {
    const url_path = ctx.http.req.baseUrl + ctx.http.req.path
    span.setAttribute('url.path', url_path)
    span.setAttribute('http.target', url_path) //> http.target is deprecated
  }

  // NOTES:
  // - !that.dbc is the case during execution of a prepared statement
  // - with _hana_prom = true, options.sql is not there (the sql is in args)
  if (that.dbc || options.dbc || options.sql) {
    if (cds.requires.multitenancy) {
      const creds = that.dbc?._connection?._settings || that.dbc?._creds //> hdb vs. @sap/hana-client
      _setAttributes(span, _getStaticDBAttributes(ctx?.tenant, creds))
    } else {
      _setAttributes(span, _getStaticDBAttributes())
    }

    _setAttributes(span, _getDynamicDBAttributes(options, args, parent))

    // augment db.statement at parent, if necessary
    if (
      span.attributes[ATTR_DB_QUERY_TEXT] &&
      parent?.attributes[ATTR_DB_SYSTEM_NAME] &&
      !parent.attributes[ATTR_DB_QUERY_TEXT]
    ) {
      parent.setAttribute(ATTR_DB_QUERY_TEXT, span.attributes[ATTR_DB_QUERY_TEXT])
    }
  }

  const otherAttributes = new Map()
  if (ctx?.tenant) otherAttributes.set('sap.tenancy.tenant_id', ctx?.tenant)
  if (options.outbound) otherAttributes.set('sap.btp.destination', options.outbound)
  _setAttributes(span, otherAttributes)
}

const _addDbRowCount = (span, res) => {
  if (!span.attributes[ATTR_DB_QUERY_TEXT]) return
  if (!['all', 'run', 'exec'].includes(span.attributes[ATTR_CODE_FUNCTION_NAME])) return

  let rowCount
  const operation = span.attributes[ATTR_DB_OPERATION_NAME]
  if (operation === 'READ') rowCount = res.length ?? 1
  // there is no attribute for affected rows -> also set returned_rows
  else if (operation in { CREATE: 1, UPDATE: 1, DELETE: 1 }) rowCount = res.changes ?? res
  if (rowCount != null) span.setAttribute('db.client.response.returned_rows', rowCount)
}

function trace(req, fn, that, args, opts = {}) {
  // only trace once served and there is a cds.context
  if (!tracer || !cds.context) return fn.apply(that, args)

  const parent = otel.trace.getActiveSpan()

  // cds.spawn gets a new root context
  let root = opts.event === 'cds.spawn'

  let kind = opts.kind
  if (kind == null) {
    // kind = SpanKind.INTERNAL //> default
    kind = SpanKind.SERVER

    if (that instanceof cds.RemoteService) kind = SpanKind.CLIENT
    else if (that instanceof cds.MessagingService) {
      const msg = cds.env.requires[that.name]
      // prettier-ignore
      const xd = (msg.queued || msg.outboxed || msg.outbox) && msg.queued !== false && msg.outboxed !== false && msg.outbox !== false
      if (msg.kind !== 'local-messaging') {
        const outboxed = xd && cds.outboxed(that) === that
        if (outboxed || fn.name === 'handle') {
          // default -> nothing to do
        } else if (!parent) {
          kind = SpanKind.CONSUMER
          root = true
        } else if (!outboxed && fn.name === 'emit') {
          // default -> nothing to do
        } else {
          kind = SpanKind.PRODUCER
        }
      }
    }
  }

  // if the parent is not recording, we don't need to continue either
  if (!root && parent?.isRecording() === false) return fn.apply(that, args)

  // augment root span with request attributes, overwrite start time, and adjust root name
  if (parent?.instrumentationLibrary?.name === '@opentelemetry/instrumentation-http' && !parent[$adjusted]) {
    parent[$adjusted] = true
    _setAttributes(parent, _getRequestAttributes())
    const ctx = cds.context
    if (ctx?.http?.req?.[$hrnow]) parent.startTime = ctx.http.req[$hrnow]
    if (ADJUST_ROOT_NAME && parent.attributes[ATTR_URL_PATH]) parent.name += ' ' + parent.attributes[ATTR_URL_PATH]
  }

  let name = typeof req === 'string' ? req : _getSpanName(req, fn, that)
  if (name === 'cds.spawn') name += kind === SpanKind.CONSUMER ? ' - run task' : ' - schedule task'
  else if (name.startsWith('messaging - emit'))
    name = name.replace('messaging - emit', `messaging - emit ${kind === SpanKind.CONSUMER ? 'incoming' : 'outgoing'}`)

  const options = {
    kind,
    root,
    attributes: {},
    links: root && parent ? [{ context: parent.spanContext() }] : undefined
  }

  // REVISIT: improve attributes handling
  //          coding relies on setting attributes on the existing span, but now we create it later (cf. startActiveSpan)
  try {
    const collector = { attributes: options.attributes, setAttribute: (k, v) => (options.attributes[k] = v) }
    // instances of NonRecordingSpan do not have attributes' data structure
    _addAttributes(collector, fn, that, opts, args, parent?.attributes ? parent : undefined)
  } catch (err) {
    LOG._warn && LOG.warn('Failed to determine attributes:', err)
  }

  // REVISIT: with _hana_prom = true, the sql is not yet in the span name
  if (name.match(/^@cap-js\/\w+ - \w+$/) && options.attributes[ATTR_DB_QUERY_TEXT]) {
    name += ' ' + options.attributes[ATTR_DB_QUERY_TEXT]
  }

  if (name.length > 80 && _truncate_span_name !== false) name = name.substring(0, 79) + '…'

  // start a new active span, call the original function, and finally end the span
  return tracer.startActiveSpan(name, options, span => {
    // in case the span is non-recording, just call the original function
    if (span.constructor.name === 'NonRecordingSpan') return fn.apply(that, args)

    // SAP Passport
    // REVISIT: fallback for _hana_prom = false
    const dbc = opts.dbc || name.startsWith('@cap-js/hana') && that.dbc
    if (process.env.SAP_PASSPORT && dbc?.set) {
      const { spanId, traceId } = span.spanContext()
      // REVISIT: @sap/dsrpassport uses '0226' for VARPARTOFFSET
      // prettier-ignore
      const passport = `${
        /* EYECATCHER      */ '2A54482A'}${
        /* VERSION         */ '03'}${
        /* LENGTH          */ '00E6'}${
        /* TRACELEVEL      */ '0000'}${
        /* COMPONENTID     */ '2020202020202020202020202020202020202020202020202020202020202020'}${
        /* SERVICE         */ '0000'}${
        /* USER            */ '2020202020202020202020202020202020202020202020202020202020202020'}${
        /* ACTION          */ '20202020202020202020202020202020202020202020202020202020202020202020202020202020'}${
        /* ACTIONTYPE      */ '0000'}${
        /* PREVCOMPONENTID */ Buffer.from(span.resource.attributes[ATTR_SERVICE_NAME].substr(0, 32).padEnd(32, ' ')).toString('hex')}${
        /* TRANSACTIONID   */ Buffer.from(traceId.toUpperCase()).toString('hex')}${
        /* CLIENT          */ '202020'}${
        /* COMPONENTTYPE   */ '0000'}${
        /* ROOTCONTEXTID   */ traceId.toUpperCase()}${
        /* CONNECTIONID    */ '0000000000000001' + spanId.toUpperCase()}${
        /* CONNECTIONCNT   */ '00000001'}${
        /* VARPARTCOUNT    */ '0000'}${
        /* VARPARTOFFSET   */ '0000' }${
        /* EYECATCHER      */ '2A54482A'}`
      LOG._debug && LOG.debug('Setting SAP Passport:', passport)
      dbc.set({ SAP_PASSPORT: passport })
    }

    const _on_success = res => {
      _addDbRowCount(span, res)
      span.setStatus({ code: SpanStatusCode.OK })
      return res
    }

    const _on_error = err => {
      span.recordException(err)
      const status = { code: SpanStatusCode.ERROR }
      if (err.message) status.message = err.message
      span.setStatus(status)
      throw err
    }

    const _on_finally = () => {
      const unfinished = span.status.code !== SpanStatusCode.UNSET && !span.ended
      if (unfinished) span.end(HRTIME ? _hrnow() : undefined)
    }

    let res
    try {
      res = fn.apply(that, args)
      if (res instanceof Promise) return res.then(_on_success, _on_error).finally(_on_finally)
      return _on_success(res)
    } catch (err) {
      _on_error(err)
    } finally {
      _on_finally()
    }
  })
}

module.exports = trace
