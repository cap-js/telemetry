const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { DiagLogLevel } = require('@opentelemetry/api')
const { hrTimeToMilliseconds, getStringFromEnv } = require('@opentelemetry/core')
const { resourceFromAttributes } = require('@opentelemetry/resources')
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

/**
 * Manages ZTI SVID file loading with mtime-based caching
 * Based on official ZTI blueprint: https://github.tools.sap/pse/blueprints
 */
class SVIDFileSource {
  constructor(certPath, keyPath, bundlePath) {
    this.certPath = certPath
    this.keyPath = keyPath
    this.bundlePath = bundlePath
    this._cached = null
    this._cachedMod = null
  }

  /**
   * Get certificate credentials, reloading if mtime changed
   * @returns {{ cert: string, key: string, bundle: string }}
   */
  getCertificate() {
    let stat
    try {
      stat = fs.statSync(this.certPath)
    } catch (e) {
      // Transient stat failure during atomic rename - serve last-known-good
      if (this._cached) {
        LOG._debug && LOG.debug('ZTI: Transient stat failure, serving cached credentials')
        return this._cached
      }
      throw e
    }

    const mtime = stat.mtimeMs
    if (this._cached && this._cachedMod === mtime) {
      // Cache hit - no rotation since last check
      return this._cached
    }

    // mtime changed or first load - reload all files atomically
    LOG._debug && LOG.debug('ZTI: Loading SVID files (mtime changed or first load)')
    try {
      const certPEM = fs.readFileSync(this.certPath, 'utf8')
      const keyPEM = fs.readFileSync(this.keyPath, 'utf8')
      const bundlePEM = fs.readFileSync(this.bundlePath, 'utf8')

      this._cached = { cert: certPEM, key: keyPEM, bundle: bundlePEM }
      this._cachedMod = mtime

      LOG._info && LOG.info('ZTI: Loaded SVID certificate', {
        certPath: this.certPath,
        mtime: new Date(mtime).toISOString()
      })

      return this._cached
    } catch (err) {
      // Read failure after successful stat - likely mid-rotation
      if (this._cached) {
        LOG._warn && LOG.warn('ZTI: Failed to reload SVID files, serving cached', err)
        return this._cached
      }
      throw err
    }
  }
}

/**
 * Detect ZTI binding from VCAP_SERVICES
 * @returns {{ svidDir: string, svidName: string } | null}
 */
function getZTIConfig() {
  if (!process.env.VCAP_SERVICES) return null

  const vcap = JSON.parse(process.env.VCAP_SERVICES)
  const zti = vcap['zero-trust-identity']
  if (!zti || zti.length === 0) return null

  // Get SVID name from binding parameters
  const svidName = zti[0].credentials?.parameters?.['svid-store']?.file?.name
  if (!svidName) {
    LOG._warn && LOG.warn('ZTI: zero-trust-identity binding found but svid-store.file.name not configured')
    return null
  }

  // Native CF apps have fixed SVID directory
  const svidDir = process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR || '/home/vcap/app/spire-svids'

  return { svidDir, svidName }
}

/**
 * Create SVID file source with blocking retry until files exist
 * Follows ZTI blueprint pattern: block startup until SVID files ready
 * @param {string} svidDir - Directory containing SVID files
 * @param {string} svidName - SVID file base name
 * @returns {Promise<SVIDFileSource>}
 */
async function createSVIDFileSource(svidDir, svidName) {
  const RETRY_INTERVAL_MS = 2000
  const MAX_RETRIES = 30 // 60 seconds total (30 * 2s)

  const source = new SVIDFileSource(
    `${svidDir}/${svidName}.svid.pem`,
    `${svidDir}/${svidName}.svid.key`,
    `${svidDir}/${svidName}.bundle.pem`
  )

  let attempt = 0
  while (true) {
    try {
      // Try to load - will throw if files don't exist
      source.getCertificate()
      LOG._info && LOG.info(`ZTI: SVID files ready at ${svidDir}/${svidName}`)
      return source
    } catch (err) {
      attempt++
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `ZTI: SVID files not available after ${MAX_RETRIES} attempts (${(MAX_RETRIES * RETRY_INTERVAL_MS) / 1000}s). ` +
          `Expected files at ${svidDir}/${svidName}.svid.{pem,key}. ` +
          `Error: ${err.message}`,
          { cause: err }
        )
      }

      LOG._debug && LOG.debug(
        `ZTI: SVID files not ready yet (attempt ${attempt}/${MAX_RETRIES}), ` +
        `retrying in ${RETRY_INTERVAL_MS}ms...`
      )

      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS))
    }
  }
}

// Global ZTI source instance (created once, reused across requests)
let _ztiSource = null
let _ztiInitPromise = null

/**
 * Initialize ZTI source (async) - called during telemetry plugin initialization
 * @returns {Promise<void>}
 */
async function initializeZTI() {
  const useZTI = process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI !== 'false'
  if (!useZTI) return

  const ztiConfig = getZTIConfig()
  if (!ztiConfig) return

  // Avoid double initialization
  if (_ztiInitPromise) return _ztiInitPromise

  _ztiInitPromise = (async () => {
    try {
      LOG._info && LOG.info('ZTI: Initializing SVID file source for CaaS mTLS...')
      _ztiSource = await createSVIDFileSource(ztiConfig.svidDir, ztiConfig.svidName)
    } catch (err) {
      LOG._error && LOG.error('ZTI: Failed to initialize SVID file source:', err)
      _ztiInitPromise = null // Allow retry
      throw err
    }
  })()

  return _ztiInitPromise
}

/**
 * Get mTLS credentials for CaaS telemetry
 * Priority:
 *   1. ZTI file-based (default, automatic rotation) - if USE_ZTI=true (default)
 *   2. Env var base64 (legacy, manual rotation) - if USE_ZTI=false
 * @returns {{ cert: string, key: string } | null}
 */
function getCredsForCaaSMtls() {
  // Check flag: default to ZTI (only disable if explicitly set to 'false')
  const useZTI = process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI !== 'false'

  if (useZTI) {
    // ZTI approach (default)
    const ztiConfig = getZTIConfig()
    if (ztiConfig) {
      // ZTI binding found - use it
      if (_ztiSource) {
        // ZTI initialized - get cached or reloaded credentials
        try {
          const { cert, key } = _ztiSource.getCertificate()
          return { cert, key }
        } catch (err) {
          LOG._error && LOG.error('ZTI: Failed to load SVID credentials:', err)
          return null
        }
      } else {
        // ZTI not yet initialized - warn and fall through
        LOG._warn && LOG.warn(
          'ZTI: SVID file source not initialized. Ensure initializeZTI() is called during startup.'
        )
        return null
      }
    }
    // No ZTI binding - fall through to legacy check
  }

  // Legacy env var approach (USE_ZTI=false or no ZTI binding)
  const { x509 } = cds.env.requires.telemetry || {}
  if (x509 && x509.cert && x509.key) {
    LOG._debug && LOG.debug('Using legacy base64 env var credentials for CaaS mTLS')
    return {
      cert: x509.cert,
      key: x509.key
    }
  }

  return null
}

function augmentCaaSCreds(credentials) {
  if (credentials._augmented) return
  credentials._augmented = true

  // check for otlp http endpoint
  if (!credentials.otlp?.http) {
    throw new Error('No OTLP HTTP endpoint found in CaaS credentials. Make sure the CaaS instance is properly configured.')
  }

  // Store the base URL - path will be added per signal type (traces: /v1/traces, metrics: /v1/metrics)
  credentials.baseUrl = credentials.otlp.http

  // Check for mTLS credentials (cert + key) - either from ZTI or legacy env vars
  const mtlsCreds = getCredsForCaaSMtls()
  if (mtlsCreds) {
    try {
      let cert, key

      // Check if legacy base64 format (starts with base64 characters, not PEM header)
      if (mtlsCreds.cert.startsWith('LS0t') || !mtlsCreds.cert.startsWith('-----BEGIN')) {
        // Legacy: base64-encoded
        cert = Buffer.from(mtlsCreds.cert, 'base64').toString('utf-8')
        key = Buffer.from(mtlsCreds.key, 'base64').toString('utf-8')
      } else {
        // ZTI: already PEM format
        cert = mtlsCreds.cert
        key = mtlsCreds.key
      }

      // Store the mTLS options for the exporter's httpAgentOptions
      // The OTLP HTTP exporter will create an https.Agent with these options
      credentials.httpAgentOptions = {
        cert: cert,
        key: key,
        keepAlive: true
      }

      LOG._debug && LOG.debug('CaaS mTLS configured successfully')
    } catch (err) {
      LOG._error && LOG.error('Failed to configure CaaS mTLS:', err.message)
    }
  } else {
    LOG._warn && LOG.warn(
      'CaaS requires mTLS authentication. No mTLS credentials found. ' +
      'Either bind zero-trust-identity service (recommended) or set ' +
      'CDS_REQUIRES_TELEMETRY_X509_CERT and CDS_REQUIRES_TELEMETRY_X509_KEY ' +
      'environment variables (base64 encoded).'
    )
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
  augmentCaaSCreds,
  initializeZTI,
  getZTIConfig,
  getCredsForCaaSMtls,
  hasDependency,
  _hrnow,
  _require,
  // Exported for testing
  _resetZTIState: () => { _ztiSource = null; _ztiInitPromise = null }
}
