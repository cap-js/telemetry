const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { _require } = require('./common')
const { getRotatingAgentFactory } = require('./mtls')

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

function augmentCaaSCreds(credentials) {
  if (credentials._augmented) return
  credentials._augmented = true

  if (!credentials.otlp?.http) {
    throw new Error('No OTLP HTTP endpoint in CaaS credentials')
  }

  credentials.baseUrl = credentials.otlp.http
  credentials.httpAgentOptions = getRotatingAgentFactory()
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

module.exports = {
  getCredsForDTAsUPS,
  getCredsForCLSAsUPS,
  augmentCLCreds,
  augmentCaaSCreds
}
