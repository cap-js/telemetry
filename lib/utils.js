const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { DiagLogLevel } = require('@opentelemetry/api')
const { hrTimeToMilliseconds } = require('@opentelemetry/core')
const { Resource } = require('@opentelemetry/resources')
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_SERVICE_NAMESPACE: ATTR_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_INSTANCE_ID: ATTR_SERVICE_INSTANCE_ID
} = require('@opentelemetry/semantic-conventions')

function getDiagLogLevel() {
  if (process.env.OTEL_LOG_LEVEL) {
    let level = Number(process.env.OTEL_LOG_LEVEL)
    if (Number.isInteger(level)) return level
    level = DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase()]
    if (!level) LOG.warn(`Unknown OTEL_LOG_LEVEL value: "${process.env.OTEL_LOG_LEVEL}", defaulting to "INFO"`)
    return level ?? DiagLogLevel.INFO
  }

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

  // TODO: If we let PKG.name override the VCAP_APPLICATION.name
  // TODO: We end up with my-app, while the name in the standarad deployment is my-app-srv
  const name = PKG?.name || VCAP_APPLICATION?.name || 'CAP Application'
  const version = PKG?.version || VCAP_APPLICATION?.application_version || '1.0.0'

  const attributes = {}

  // Service
  attributes[ATTR_SERVICE_NAME] = process.env.OTEL_SERVICE_NAME || name
  attributes[ATTR_SERVICE_VERSION] = process.env.OTEL_SERVICE_VERSION || version

  // Service (Experimental)
  if (process.env.OTEL_SERVICE_NAMESPACE) attributes[ATTR_SERVICE_NAMESPACE] = process.env.OTEL_SERVICE_NAMESPACE
  if (VCAP_APPLICATION) attributes[ATTR_SERVICE_INSTANCE_ID] = VCAP_APPLICATION.instance_id

  if (process.env.CF_INSTANCE_GUID) {
    attributes[ATTR_SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
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

  if (cds.env.requires.telemetry?.resource?.attributes)
    Object.assign(attributes, cds.env.requires.telemetry.resource.attributes)

  return new Resource(attributes)
}

let dtmetadata
function getDynatraceMetadata() {
  if (dtmetadata) return dtmetadata

  dtmetadata = new Resource({})
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
      dtmetadata = dtmetadata.merge(new Resource(JSON.parse(content)))
      break
    } catch (err) {
      LOG._debug && LOG.debug('Failed with error:', err)
    }
  }
  return dtmetadata
}

function getCredsForDTAsUPS() {
  if (!process.env.VCAP_SERVICES) return
  const vcap = JSON.parse(process.env.VCAP_SERVICES)

  // Legacy Compat:
  // > APMs requirement is that the instance name contains "dynatrace"
  // > In addition to matching predicate defined in package.json, also support
  // > - name matching /dynatrace/
  // ... in case binding info is available from environment variable VCAP_SERVICES
  const dt = vcap['user-provided']?.find(b => b.name.match(/dynatrace/))
  if (dt) return dt.credentials
}

function getCredsForCLSAsUPS() {
  if (!process.env.VCAP_SERVICES) return
  const vcap = JSON.parse(process.env.VCAP_SERVICES)
  let ups

  // Legacy Compat:
  // > In addition to matching predicate defined in package.json, also support
  // > - tag: "cloud-logging"
  // > - name matching /cloud-logging/
  // ... in case binding info is available from environment variable VCAP_SERVICES
  ups = vcap['user-provided']?.find(e => e.tags.includes('cloud-logging') || e.tags.includes('Cloud Logging'))
  if (ups) return ups.credentials

  ups = vcap['user-provided']?.find(b => b.name.match(/cloud-logging/))
  if (ups) {
    // prettier-ignore
    LOG._warn && LOG.warn('User-provided service instances of SAP Cloud Logging should have the tag "Cloud Logging"')
    return ups.credentials
  }
}

function augmentCLCreds(credentials) {
  if (credentials._augmented) return
  credentials._augmented = true

  // prettier-ignore
  if (!credentials['ingest-otlp-endpoint'])
    throw new Error('No OpenTelemetry credentials found in binding to SAP Cloud Logging. Make sure to create the service instance with config: "{ ingest_otlp: { enabled: true } }".')

  credentials.url = 'https://' + credentials['ingest-otlp-endpoint']

  const grpc = _require('@grpc/grpc-js')
  const secureContext = require('tls').createSecureContext({
    cert: credentials['ingest-otlp-cert'],
    key: credentials['ingest-otlp-key']
  })
  credentials.credentials = grpc.credentials.createFromSecureContext(secureContext)
}

let PKG
function hasDependency(name) {
  if (!PKG) {
    try {
      PKG = require(cds.root + '/package.json')
    } catch (err) {
      LOG._info && LOG.info(`Unable to require package.json to check for dependency "${name}" due to error:`, err)
      return false
    }
  }
  return !!PKG.dependencies[name]
}

const now = Date.now()
const hrTimeInMS = Number(`${hrTimeToMilliseconds(process.hrtime())}`.split('.')[0])
const diff = now - hrTimeInMS
const EPOCH_OFFSET_S = Number(`${diff}`.slice(0, -3))
const EPOCH_OFFSET_MS = Number(`${diff}`.slice(-3) + '000000')

// returns [seconds, nanoseconds] since unix epoch
function _hrnow() {
  const hrtime = process.hrtime()
  let s = hrtime[0] + EPOCH_OFFSET_S
  let ns = hrtime[1] + EPOCH_OFFSET_MS
  if (ns >= 1000000000) {
    s++
    ns -= 1000000000
  }
  return [s, ns]
}

function _require(name) {
  name = Array.isArray(name) ? name[0] : name
  try {
    return require(name.startsWith('./') ? cds.utils.path.join(cds.root, name) : name)
  } catch (err) {
    err.message = `Cannot find module '${name}'. Make sure to install it with 'npm i ${name}'\n` + err.message
    throw err
  }
}

module.exports = {
  getDiagLogLevel,
  getResource,
  getDynatraceMetadata,
  getCredsForDTAsUPS,
  getCredsForCLSAsUPS,
  augmentCLCreds,
  hasDependency,
  _hrnow,
  _require
}
