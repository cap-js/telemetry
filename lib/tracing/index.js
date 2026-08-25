const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { getStringFromEnv } = require('@opentelemetry/core')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const { BatchSpanProcessor, SimpleSpanProcessor, SamplingDecision } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const {
  getDynatraceMetadata,
  getCredsForDTAsUPS,
  getCredsForCLSAsUPS,
  augmentCLCreds,
  augmentCaaSCreds,
  getCredsForCaaSMtls,
  hasDependency,
  _require
} = require('../utils')

// Common setup: SAP Passport clearing for HANA
function _setupSAPPassport() {
  if (process.env.SAP_PASSPORT) {
    cds.on('served', () => {
      cds.db?.before('BEGIN', async function () {
        if (this.dbc?.constructor.name in { HDBDriver: 1, HANAClientDriver: 1 }) this.dbc.set({ SAP_PASSPORT: '' })
      })
    })
  }
}

// Common resource merging
function _mergeResource(resource) {
  return resourceFromAttributes({}).merge(resource).merge(getDynatraceMetadata())
}

// Check if Dynatrace OneAgent is active
function _hasDynatraceOneAgent() {
  return (
    process.env.DT_NODE_PRELOAD_OPTIONS &&
    cds.env.requires.telemetry.kind.match(/to-dynatrace$/) &&
    !hasDependency('@opentelemetry/exporter-trace-otlp-proto')
  )
}

// Create span processor with exporter
function _createSpanProcessor(exporter) {
  const processorConfig = cds.env.requires.telemetry.tracing.processor?.config || {}
  return process.env.NODE_ENV === 'production'
    ? new BatchSpanProcessor(exporter, processorConfig)
    : new SimpleSpanProcessor(exporter, processorConfig)
}

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
    let protocol =
      getStringFromEnv('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')
    // on kyma, the otlp endpoint speaks grpc, but otel's default protocol is http/protobuf -> fix default
    if (!protocol) {
      const endpoint =
        getStringFromEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT') ?? ''
      if (endpoint.match(/:4317/)) protocol = 'grpc'
    }
    protocol ??=
      getStringFromEnv('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL') ?? getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')
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
    if (!credentials) throw new Error('No Dynatrace credentials found. Make sure the bound service instance uses the tag "dynatrace".')
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
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found. Make sure the bound service instance uses the tag "Cloud Logging".')
    augmentCLCreds(credentials)
    config.url ??= credentials.url
    config.credentials ??= credentials.credentials
  }

  // For CaaS with ZTI, use lazy exporter to handle credentials not being ready yet
  if (kind.match(/to-caas$/)) {
    if (!credentials) throw new Error('No CaaS credentials found.')

    // Set up base URL once (this part of augmentCaaSCreds is idempotent)
    augmentCaaSCreds(credentials)

    const { createLazyExporter } = require('../exporter/LazyExporter')
    const lazyExporter = createLazyExporter(() => {
      // This runs lazily on each export attempt until credentials are ready
      // We need to check for mTLS credentials fresh each time (not rely on _augmented flag)
      const mtlsCreds = getCredsForCaaSMtls()
      if (!mtlsCreds) {
        // Credentials not ready yet (ZTI SVID files don't exist)
        throw new Error('SVID credentials not ready')
      }

      // Decode credentials (ZTI returns PEM, legacy returns base64)
      let cert, key
      if (mtlsCreds.cert.startsWith('LS0t') || !mtlsCreds.cert.startsWith('-----BEGIN')) {
        cert = Buffer.from(mtlsCreds.cert, 'base64').toString('utf-8')
        key = Buffer.from(mtlsCreds.key, 'base64').toString('utf-8')
      } else {
        cert = mtlsCreds.cert
        key = mtlsCreds.key
      }

      const exporterConfig = {
        ...config,
        url: credentials.baseUrl + '/v1/traces',
        httpAgentOptions: { cert, key, keepAlive: true }
      }
      return new tracingExporterModule[tracingExporter.class](exporterConfig)
    })
    LOG._debug && LOG.debug('Using lazy trace exporter for CaaS')
    return lazyExporter
  }

  const exporter = new tracingExporterModule[tracingExporter.class](config)
  LOG._debug && LOG.debug('Using trace exporter:', exporter)

  return exporter
}

/**
 * Setup tracing - creates TracerProvider with exporter.
 * For CaaS with ZTI, the exporter is wrapped with LazyExporter
 * to handle credentials not being ready at startup.
 */
function setupTracing(resource) {
  if (!cds.env.requires.telemetry.tracing?.exporter) return

  _setupSAPPassport()

  let processor
  if (_hasDynatraceOneAgent()) {
    LOG._info && LOG.info('Dynatrace OneAgent detected, disabling trace exporter')
  } else {
    const exporter = _getExporter()
    processor = _createSpanProcessor(exporter)
  }

  // CALM setup - add as delegate
  if (!resource) {
    LOG.warn("@sap/xotel-agent-ext-js found, adding @cap-js/telemetry's span processor as delegate")
    try {
      const { getCompositeSpanProcessor } = require('@sap/xotel-agent-ext-js')
      getCompositeSpanProcessor().addDelegate(processor)
      return
    } catch (error) {
      LOG.error('Failed to add span processor as delegate:', error)
      throw error
    }
  }

  // Standard setup
  resource = _mergeResource(resource)
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [processor], sampler: _getSampler() })
  tracerProvider.register({ propagator: _getPropagator() })
  return tracerProvider
}

module.exports = setupTracing
