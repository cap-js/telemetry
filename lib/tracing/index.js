const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { trace, SpanKind } = require('@opentelemetry/api')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions')

const { getDynatraceCredentials, getCloudLoggingCredentials, _require } = require('../utils')

// function _isDynatraceEnabled() {
//   try {
//     const pkg = require(cds.root + '/package.json')
//     return Object.keys(pkg.dependencies).includes('@dynatrace/oneagent-sdk')
//   } catch (err) {
//     LOG._info &&
//       LOG.info(
//         'Unable to require package.json to check whether @dynatrace/oneagent-sdk is in dependencies due to error:',
//         err
//       )
//   }
//   return false
// }

function _getSampler() {
  function _ignoreSpecifiedPaths(spanName, spanKind, attributes) {
    if (!cds.env.requires.telemetry.instrumentations?.http) return false

    const { ignoreIncomingPaths } = cds.env.requires.telemetry.instrumentations.http
    return (
      !Array.isArray(ignoreIncomingPaths) ||
      (Array.isArray(ignoreIncomingPaths) && !ignoreIncomingPaths.some(path => path === spanName)
        ? spanKind !== SpanKind.SERVER ||
          !ignoreIncomingPaths.some(path => path === attributes[SemanticAttributes.HTTP_ROUTE])
        : false)
    )
  }

  function _filterSampler(filterFn, parent) {
    const { NOT_RECORD } = require('@opentelemetry/sdk-trace-base').SamplingDecision
    return {
      shouldSample(ctx, tid, spanName, spanKind, attr, links) {
        if (!filterFn(spanName, spanKind, attr)) return { decision: NOT_RECORD }
        return parent.shouldSample(ctx, tid, spanName, spanKind, attr, links)
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

  return _filterSampler(_ignoreSpecifiedPaths, sampler)
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

function _getInstrumentations() {
  const instrumentations = []
  for (const each of Object.values(cds.env.requires.telemetry.instrumentations)) {
    const module = _require(each.module)
    if (!module[each.class]) throw new Error(`Unknown instrumentation "${each.class}" in module "${each.module}"`)
    instrumentations.push(new module[each.class]({ ...(each.config || {}) }))
  }
  return instrumentations
}

function _getExporter() {
  const tracingExporter = cds.env.requires.telemetry.tracing.exporter
  // use _require for better error message
  const tracingExporterModule =
    tracingExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(tracingExporter.module)
  if (!tracingExporterModule[tracingExporter.class])
    throw new Error(`Unknown tracing exporter "${tracingExporter.class}" in module "${tracingExporter.module}"`)
  const tracingConfig = { ...(tracingExporter.config || {}) }

  const dynatrace = getDynatraceCredentials()
  if (dynatrace && cds.env.requires.telemetry.kind.match(/dynatrace/)) {
    tracingConfig.url ??= `${dynatrace.apiurl}/v2/otlp/v1/traces`
    tracingConfig.headers ??= {}
    // dynatrace.rest_apitoken?.token is deprecated and only supported for compatibility reasons
    const token = dynatrace.otel_apitoken || dynatrace.metrics_apitoken || dynatrace.rest_apitoken?.token
    if (!token) throw new Error('Neither otel_apitoken, traces_apitoken nor rest_apitoken.token found in Dynatrace credentials')
    tracingConfig.headers.authorization ??= `Api-Token ${token}`
  }

  const clc = getCloudLoggingCredentials()
  if (clc && cds.env.requires.telemetry.kind.match(/cloud-logging/)) {
    tracingConfig.url ??= clc.url
    tracingConfig.credentials ??= clc.credentials
  }

  const exporter = new tracingExporterModule[tracingExporter.class](tracingConfig)
  LOG._debug && LOG.debug('Using tracing exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.tracing?.exporter) return

  /*
   * general setup
   */
  const tracerProvider = new NodeTracerProvider({ resource, sampler: _getSampler() })
  tracerProvider.register({ propagator: _getPropagator() })
  const instrumentations = _getInstrumentations()
  registerInstrumentations({ tracerProvider, instrumentations })

  // if (_isDynatraceEnabled() || cds.env.requires.telemetry.kind.match(/dynatrace/)) {
  //   // no exporter needed
  // } else {
  //   const exporter = _getExporter()
  //   const spanProcessor =
  //     process.env.NODE_ENV === 'production' ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter)
  //   tracerProvider.addSpanProcessor(spanProcessor)
  // }
  const exporter = _getExporter()
  const spanProcessor =
    process.env.NODE_ENV === 'production' ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter)
  tracerProvider.addSpanProcessor(spanProcessor)

  // REVISIT: better way to set/ pass tracer?
  cds._telemetry.tracer = trace.getTracer(cds._telemetry.name, cds._telemetry.version)

  // REVISIT: only start tracing once served
  cds.on('served', () => {
    cds._telemetry.tracer._active = true
  })

  /*
   * add CAP instrumentations
   */
  require('./cds')()
  require('./okra')()
  require('./cloud_sdk')()
}
