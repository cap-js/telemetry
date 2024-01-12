const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

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
  const VCAP_APPLICATION = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)
  let PKG
  try {
    PKG = require(cds.root + '/package.json')
  } catch (err) {
    LOG._info && LOG.info('Unable to require package.json to resolve app name and version due to error:', err)
  }

  const name = PKG?.name || VCAP_APPLICATION?.name || 'CAP Application'
  const version = PKG?.version || VCAP_APPLICATION?.application_version || '1.0.0'

  const attributes = {}

  // Service
  attributes[SemanticResourceAttributes.SERVICE_NAME] = process.env.OTEL_SERVICE_NAME || name
  attributes[SemanticResourceAttributes.SERVICE_VERSION] = process.env.OTEL_SERVICE_VERSION || version

  // Service (Experimental)
  if (process.env.OTEL_SERVICE_NAMESPACE)
    attributes[SemanticResourceAttributes.SERVICE_NAMESPACE] = process.env.OTEL_SERVICE_NAMESPACE
  if (VCAP_APPLICATION) attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = VCAP_APPLICATION.instance_id

  if (process.env.CF_INSTANCE_GUID) {
    attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
    attributes['sap.cf.instance_id'] = process.env.CF_INSTANCE_GUID
  }

  if (VCAP_APPLICATION) {
    attributes['sap.cf.source_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_name'] = name
    attributes['sap.cf.space_id'] = VCAP_APPLICATION.space_id
    attributes['sap.cf.space_name'] = VCAP_APPLICATION.space_name
    attributes['sap.cf.org_id'] = VCAP_APPLICATION.organization_id
    attributes['sap.cf.org_name'] = VCAP_APPLICATION.organization_name
    attributes['sap.cf.source_type'] = 'APP/PROC/WEB'
    attributes['sap.cf.process.id'] = VCAP_APPLICATION.process_id
    attributes['sap.cf.process.instance_id'] = VCAP_APPLICATION.instance_id
    attributes['sap.cf.process.type'] = VCAP_APPLICATION.process_type
  }

  return new Resource(attributes)
}

function getCloudLoggingCredentials() {
  const cloud_logging =
    process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES)['cloud-logging']?.[0]?.credentials
  if (cloud_logging) {
    const grpc = _require('@grpc/grpc-js')
    const secureContext = require('tls').createSecureContext({
      cert: cloud_logging['ingest-mtls-cert'],
      key: cloud_logging['ingest-mtls-key']
    })
    return {
      url: 'https://' + cloud_logging['ingest-mtls-endpoint'],
      credentials: grpc.credentials.createFromSecureContext(secureContext)
    }
  }
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
  getCloudLoggingCredentials,
  _require
}
