const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { getStringFromEnv } = require('@opentelemetry/core')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_SERVICE_NAMESPACE: ATTR_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_INSTANCE_ID: ATTR_SERVICE_INSTANCE_ID
} = require('@opentelemetry/semantic-conventions')

function getResource() {
  const VCAP_APPLICATION = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)

  let PKG
  try {
    PKG = require(cds.root + '/package.json')
  } catch (err) {
    LOG._info && LOG.info('Unable to require package.json to resolve app name and version due to error:', err)
  }

  const name = VCAP_APPLICATION?.name || PKG?.name || 'CAP Application'
  const version = PKG?.version || VCAP_APPLICATION?.application_version || '1.0.0'

  const attributes = {}

  // Service
  attributes[ATTR_SERVICE_NAME] = getStringFromEnv('OTEL_SERVICE_NAME') || name
  attributes[ATTR_SERVICE_VERSION] = getStringFromEnv('OTEL_SERVICE_VERSION') || version

  // Service (Experimental)
  if (getStringFromEnv('OTEL_SERVICE_NAMESPACE'))
    attributes[ATTR_SERVICE_NAMESPACE] = getStringFromEnv('OTEL_SERVICE_NAMESPACE')
  if (VCAP_APPLICATION) attributes[ATTR_SERVICE_INSTANCE_ID] = VCAP_APPLICATION.instance_id

  if (process.env.CF_INSTANCE_GUID) {
    attributes[ATTR_SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
    attributes['sap.cf.instance_id'] = process.env.CF_INSTANCE_GUID
  }

  if (VCAP_APPLICATION) {
    attributes['sap.cf.source_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_name'] = VCAP_APPLICATION.name
    attributes['sap.cf.space_id'] = VCAP_APPLICATION.space_id
    attributes['sap.cf.space_name'] = VCAP_APPLICATION.space_name
    attributes['sap.cf.org_id'] = VCAP_APPLICATION.organization_id
    attributes['sap.cf.org_name'] = VCAP_APPLICATION.organization_name
    attributes['sap.cf.source_type'] = 'APP/PROC/WEB'
    attributes['sap.cf.process.id'] = VCAP_APPLICATION.process_id
    attributes['sap.cf.process.instance_id'] = VCAP_APPLICATION.instance_id
    attributes['sap.cf.process.type'] = VCAP_APPLICATION.process_type
  }

  if (cds.env.requires.telemetry?.resource?.attributes)
    Object.assign(attributes, cds.env.requires.telemetry.resource.attributes)

  return resourceFromAttributes(attributes)
}

let dtmetadata
function getDynatraceMetadata() {
  if (dtmetadata) return dtmetadata

  dtmetadata = resourceFromAttributes({})
  for (let name of [
    'dt_metadata_e617c525669e072eebe3d0f08212e8f2.json',
    '/var/lib/dynatrace/enrichment/dt_metadata.json'
  ]) {
    try {
      LOG._debug && LOG.debug(`Trying to read dtmetadata source "${name}" ...`)
      const content = fs
        .readFileSync(name.startsWith('/var') ? name : fs.readFileSync(name).toString('utf-8').trim())
        .toString('utf-8')
      LOG._debug && LOG.debug('Successful')
      dtmetadata = dtmetadata.merge(resourceFromAttributes(JSON.parse(content)))
      break
    } catch (err) {
      LOG._debug && LOG.debug('Failed with error:', err)
    }
  }
  return dtmetadata
}

module.exports = {
  getResource,
  getDynatraceMetadata
}
