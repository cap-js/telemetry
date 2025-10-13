const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { trace } = require('@opentelemetry/api')
const { ExportResultCode, getEnv, getEnvWithoutDefaults } = require('@opentelemetry/core')
const { Resource } = require('@opentelemetry/resources')
const { BatchSpanProcessor, SimpleSpanProcessor, SamplingDecision } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const {
  getDynatraceMetadata,
  getCredsForDTAsUPS,
  getCredsForCLSAsUPS,
  augmentCLCreds,
  hasDependency,
  _require
} = require('../utils')

function _getSampler() {
  const { ignoreIncomingPaths } = cds.env.requires.telemetry.tracing?.sampler || {}

  let _shouldSample
  if (!Array.isArray(ignoreIncomingPaths) || !ignoreIncomingPaths.length) _shouldSample = () => true
  else {
    // eslint-disable-next-line no-unused-vars
    _shouldSample = (_context, _traceId, _name, _spanKind, attributes, _links) => {
      const url_path = attributes?.['url.path'] || attributes?.['http.target'] //> http.target is deprecated
      if (!url_path) return true
      return !ignoreIncomingPaths.some(p => url_path.startsWith(p))
    }
  }

  function _filterSampler(_shouldSample, parent) {
    return {
      shouldSample(context, traceId, name, spanKind, attributes, links) {
        if (!_shouldSample(context, traceId, name, spanKind, attributes, links))
          return { decision: SamplingDecision.NOT_RECORD }
        return parent.shouldSample(context, traceId, name, spanKind, attributes, links)
      }
    }
  }

  let sampler
  const { kind, root, ratio } = cds.env.requires.telemetry.tracing.sampler
  const base = require('@opentelemetry/sdk-trace-base')
  if (!base[kind]) throw new Error(`Unknown sampler ${kind}`)
  if (kind === 'ParentBasedSampler') {
    if (!base[root]) throw new Error(`Unknown sampler ${root}`)
    sampler = new base[kind]({ root: new base[root](ratio || 0) })
  } else {
    sampler = new base[kind]()
  }

  return _filterSampler(_shouldSample, sampler)
}

function _getPropagator() {
  const propagators = []
  const core = require('@opentelemetry/core')
  for (const each of cds.env.requires.telemetry.tracing.propagators) {
    if (typeof each === 'string') {
      if (!core[each]) throw new Error(`Unknown propagator "${each}" in module "@opentelemetry/core"`)
      propagators.push(new core[each]())
    } else {
      const module = _require(each.module)
      if (!module[each.class]) throw new Error(`Unknown propagator "${each.class}" in module "${each.module}"`)
      propagators.push(new module[each.class]({ ...(each.config || {}) }))
    }
  }
  return new core.CompositePropagator({ propagators })
}

const _protocol2module = {
  grpc: '@opentelemetry/exporter-trace-otlp-grpc',
  'http/protobuf': '@opentelemetry/exporter-trace-otlp-proto',
  'http/json': '@opentelemetry/exporter-trace-otlp-http'
}

function _getExporter() {
  let {
    kind,
    tracing: { exporter: tracingExporter },
    credentials
  } = cds.env.requires.telemetry

  // for kind telemetry-to-otlp based on env vars
  if (tracingExporter === 'env') {
    const cstm_env = getEnvWithoutDefaults()
    const otlp_env = getEnv()
    let protocol = cstm_env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? cstm_env.OTEL_EXPORTER_OTLP_PROTOCOL
    // on kyma, the otlp endpoint speaks grpc, but otel's default protocol is http/protobuf -> fix default
    if (!protocol) {
      const endpoint = otlp_env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? otlp_env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ''
      if (endpoint.match(/:4317/)) protocol = 'grpc'
    }
    protocol ??= otlp_env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? otlp_env.OTEL_EXPORTER_OTLP_PROTOCOL
    tracingExporter = { module: _protocol2module[protocol], class: 'OTLPTraceExporter' }
  }

  // use _require for better error message
  const tracingExporterModule =
    tracingExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(tracingExporter.module)
  if (!tracingExporterModule[tracingExporter.class])
    throw new Error(`Unknown trace exporter "${tracingExporter.class}" in module "${tracingExporter.module}"`)
  const config = { ...(tracingExporter.config || {}) }

  if (kind.match(/to-dynatrace$/)) {
    if (!credentials) credentials = getCredsForDTAsUPS()
    if (!credentials) throw new Error('No Dynatrace credentials found')
    config.url ??= `${credentials.apiurl}/v2/otlp/v1/traces`
    config.headers ??= {}
    // credentials.rest_apitoken?.token is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    const token = credentials[token_name] || credentials.rest_apitoken?.token
    if (!token)
      throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)
    config.headers.authorization ??= `Api-Token ${token}`
  }

  if (kind.match(/to-cloud-logging$/)) {
    if (!credentials) credentials = getCredsForCLSAsUPS()
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found')
    augmentCLCreds(credentials)
    config.url ??= credentials.url
    config.credentials ??= credentials.credentials
  }

  const exporter = new tracingExporterModule[tracingExporter.class](config)
  LOG._debug && LOG.debug('Using trace exporter:', exporter)

  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.tracing?.exporter) return

  /*
   * general setup
   */
  let tracerProvider = trace.getTracerProvider()
  if (!tracerProvider.getDelegateTracer()) {
    const dtmetadata = getDynatraceMetadata()
    resource = new Resource({}).merge(resource).merge(dtmetadata)
    tracerProvider = new NodeTracerProvider({ resource, sampler: _getSampler() })
    tracerProvider.register({ propagator: _getPropagator() })
  } else {
    LOG._warn && LOG.warn('TracerProvider already initialized by a different module. It will be used as is.')
    tracerProvider = tracerProvider.getDelegate()
  }
  const via_one_agent =
    process.env.DT_NODE_PRELOAD_OPTIONS &&
    cds.env.requires.telemetry.kind.match(/to-dynatrace$/) &&
    !hasDependency('@opentelemetry/exporter-trace-otlp-proto')
  if (via_one_agent) {
    // if Dynatrace OneAgent is present, no exporter is needed
    LOG._info && LOG.info('Dynatrace OneAgent detected, disabling trace exporter')
  } else {
    const exporter = _getExporter()

    // HACK: do not export @opentelemetry/instrumentation-hdb spans if xotel agent is used
    LOG.info('process.execArgv:', process.execArgv)
    LOG.info('@sap/xotel-agent-ext-js:', process.execArgv?.some(a => a.match(/@sap\/xotel-agent-ext-js/)))
    if (process.env.SAP_CALM_SERVICE_NAME || process.execArgv?.some(a => a.match(/@sap\/xotel-agent-ext-js/))) {
      const { export: _export } = exporter
      exporter.export = function (spans, resultCallback) {
        const _spans = spans.filter(s => s.instrumentationLibrary?.name !== '@opentelemetry/instrumentation-hdb')
        if (!_spans.length) return resultCallback({ code: ExportResultCode.SUCCESS })
        return _export.call(this, spans, resultCallback)
      }
    }

    const processorConfig = cds.env.requires.telemetry.tracing.processor?.config || {}
    const processor =
      process.env.NODE_ENV === 'production'
        ? new BatchSpanProcessor(exporter, processorConfig)
        : new SimpleSpanProcessor(exporter, processorConfig)
    tracerProvider.addSpanProcessor(processor)
  }

  // clear sap passport for new tx
  if (process.env.SAP_PASSPORT) {
    cds.on('served', () => {
      cds.db?.before('BEGIN', async function () {
        if (this.dbc?.constructor.name in { HDBDriver: 1, HANAClientDriver: 1 }) this.dbc.set({ SAP_PASSPORT: '' })
      })
    })
  }

  /*
   * add tracing
   */
  require('./cds')()
  require('./cloud_sdk')()

  return tracerProvider
}
