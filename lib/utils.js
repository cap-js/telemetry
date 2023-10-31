const cds = require('@sap/cds')
const LOG = cds.log('otel')

const { DiagLogLevel } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions')

function getDiagLogLevel() {
  if (LOG._trace) return DiagLogLevel.VERBOSE
  if (LOG._debug) return DiagLogLevel.DEBUG
  if (LOG._info) return DiagLogLevel.INFO
  if (LOG._warn) return DiagLogLevel.WARN
  if (LOG._error) return DiagLogLevel.ERROR
  return DiagLogLevel.NONE
}

function getResource() {
  let name = 'CAP Application'
  let version = '1.0.0'
  try {
    const pkg = require(cds.root + '/package.json')
    name = pkg.name
    version = pkg.version
  } catch (err) {
    LOG._info && LOG.info('Unable to require package.json to resolve app name and version due to error:', err)
  }

  // REVISIT: Think about adding more from:
  // https://github.tools.sap/CPA/telemetry-semantic-conventions/blob/main/specification/sap-extensions/resource/service.md
  const attributes = {
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || name,
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE,
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || version,
    [SemanticResourceAttributes.PROCESS_RUNTIME_NAME]: 'nodejs',
    [SemanticResourceAttributes.PROCESS_RUNTIME_VERSION]: process.versions.node,
    [SemanticResourceAttributes.PROCESS_PID]: process.pid,
    'process.parent_pid': process.ppid,
    // [SemanticResourceAttributes.PROCESS_EXECUTABLE_NAME]: process.execArgv, // REVISIT: What is the executable name
    [SemanticResourceAttributes.PROCESS_EXECUTABLE_PATH]: process.execPath,
    // [SemanticResourceAttributes.PROCESS_OWNER]: process.owner, // REVISIT: Who should be the owner
    'sap.visibility.level': process.env.NODE_ENV !== 'production' ? 'confidential' : 'internal'
  }

  if (process.env.CF_INSTANCE_GUID) {
    attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
  }

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

function isDynatraceEnabled() {
  try {
    const pkg = require(cds.root + '/package.json')
    return Object.keys(pkg.dependencies).includes('@dynatrace/oneagent-sdk')
  } catch (err) {
    LOG._info && LOG.info('Unable to require package.json to check whether @dynatrace/oneagent-sdk is in dependencies due to error:', err)
  }
  return false
}

function _require(name) {
  name = Array.isArray(name) ? name[0] : name
  try {
    return require(name)
  } catch (e) {
    e.message = `Cannot find module '${name}'. Make sure to install it with 'npm i ${name}'\n` + e.message
    throw e
  }
}

module.exports = {
  getDiagLogLevel,
  getResource,
  isDynatraceEnabled,
  _require
}