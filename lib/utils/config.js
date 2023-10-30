const { SpanKind } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { SemanticAttributes, SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions')

// use _require for better error message
const _require = require('./require')

function getInstrumentations() {
  const instrumentations = []
  for (const each of Object.values(cds.env.requires.telemetry.instrumentations)) {
    const module = _require(each.module)
    if (!module[each.class]) throw new Error(`Unknown instrumentation "${each.class}" in module "${each.module}"`)
    instrumentations.push(new module[each.class]({ ...(each.config || {}) }))
  }
  return instrumentations
}

function getResource() {
  // REVISIT: Think about adding more from:
  // https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/service.md
  const attributes = {
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME
      ? process.env.OTEL_SERVICE_NAME
      : cds.env.requires.otel.trace.name, // Set service name to CDS Service
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: cds.env.requires.otel.trace.name,
    [SemanticResourceAttributes.SERVICE_VERSION]: cds.env.requires.otel.trace.version,
    [SemanticResourceAttributes.PROCESS_RUNTIME_NAME]: 'nodejs',
    [SemanticResourceAttributes.PROCESS_RUNTIME_VERSION]: process.versions.node,
    [SemanticResourceAttributes.PROCESS_PID]: process.pid,
    'process.parent_pid': process.ppid,
    // [SemanticResourceAttributes.PROCESS_EXECUTABLE_NAME]: process.execArgv, // REVISIT: What is the executable name
    [SemanticResourceAttributes.PROCESS_EXECUTABLE_PATH]: process.execPath,
    // [SemanticResourceAttributes.PROCESS_OWNER]: process.owner, // REVISIT: Who should be the owner
    'sap.visibility.level': process.env.NODE_ENV !== 'production' ? 'confidential' : 'internal'
  }

  if (process.env.CF_INSTANCE_GUID)
    attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID

  // Specified CF attributes in https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/cf.md
  const vcapApplication = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)
  if (vcapApplication) {
    attributes['sap.cf.source_id'] = vcapApplication.application_id
    attributes['sap.cf.instance_id'] = process.env.CF_INSTANCE_GUID
    attributes['sap.cf.app_id'] = vcapApplication.application_id
    attributes['sap.cf.app_name'] = vcapApplication.name
    attributes['sap.cf.space_id'] = vcapApplication.space_id
    attributes['sap.cf.space_name'] = vcapApplication.space_name
    attributes['sap.cf.org_id'] = vcapApplication.organization_id
    attributes['sap.cf.org_name'] = vcapApplication.organization_name
    // attributes["sap.cf.source_type"] = vcapApplication -- for logs // REVISIT: ???
    attributes['sap.cf.process.id'] = vcapApplication.process_id
    attributes['sap.cf.process.instance_id'] = vcapApplication.process_id // REVISIT: Not sure
    attributes['sap.cf.process.type'] = vcapApplication.process_type
  }

  return new Resource(attributes)
}

function getSampler() {
  function _ignoreSpecifiedPaths(spanName, spanKind, attributes) {
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

function getPropagator() {
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

module.exports = {
  getInstrumentations,
  getResource,
  getSampler,
  getPropagator
}