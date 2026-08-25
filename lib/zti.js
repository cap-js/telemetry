const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

// Retry settings for waiting on SVID files during startup
const ZTI_RETRY_INTERVAL_MS = 2000
const ZTI_MAX_RETRIES = 30 // 60 seconds total

// SVID paths and cached credentials (initialized once, reused across requests)
let _paths = null // { cert, key, bundle } - file paths
let _cached = null // { cert, key, bundle, mtime } - cached credentials

/**
 * Get SVID certificate credentials, reloading if mtime changed.
 * Manages mtime-based caching for automatic certificate rotation.
 * @returns {{ cert: string, key: string, bundle: string }}
 */
function _getSVIDCertificate() {
  let stat
  try {
    stat = fs.statSync(_paths.cert)
  } catch (e) {
    // Transient stat failure during atomic rename - serve last-known-good
    if (_cached) {
      LOG._debug && LOG.debug('ZTI: Transient stat failure, serving cached credentials')
      return _cached
    }
    throw e
  }

  const mtime = stat.mtimeMs
  if (_cached?.mtime === mtime) {
    // Cache hit - no rotation since last check
    return _cached
  }

  // mtime changed or first load - reload all files atomically
  try {
    _cached = {
      cert: fs.readFileSync(_paths.cert, 'utf8'),
      key: fs.readFileSync(_paths.key, 'utf8'),
      bundle: fs.readFileSync(_paths.bundle, 'utf8'),
      mtime
    }
    return _cached
  } catch (err) {
    // Read failure after successful stat - likely mid-rotation
    if (_cached) {
      LOG._warn && LOG.warn('ZTI: Failed to reload SVID files, serving cached', err)
      return _cached
    }
    throw err
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
 * Initialize SVID file paths and block until files exist
 * Follows ZTI blueprint pattern: block startup until SVID files ready
 * @param {string} svidDir - Directory containing SVID files
 * @param {string} svidName - SVID file base name
 * @returns {Promise<void>}
 */
async function _initializeSVIDFiles(svidDir, svidName) {
  _paths = {
    cert: `${svidDir}/${svidName}.svid.pem`,
    key: `${svidDir}/${svidName}.svid.key`,
    bundle: `${svidDir}/${svidName}.bundle.pem`
  }

  let attempt = 0
  while (true) {
    try {
      _getSVIDCertificate()
      return
    } catch (err) {
      if (++attempt >= ZTI_MAX_RETRIES) {
        throw new Error(`ZTI: SVID files not available at ${_paths.cert} after ${ZTI_MAX_RETRIES * ZTI_RETRY_INTERVAL_MS / 1000}s`, { cause: err })
      }
      await new Promise(resolve => setTimeout(resolve, ZTI_RETRY_INTERVAL_MS))
    }
  }
}

// Global ZTI initialization state
let _ztiInitialized = false
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
      await _initializeSVIDFiles(ztiConfig.svidDir, ztiConfig.svidName)
      _ztiInitialized = true
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
      if (_ztiInitialized) {
        // ZTI initialized - get cached or reloaded credentials
        try {
          const { cert, key } = _getSVIDCertificate()
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

/**
 * Check if ZTI wait is needed for CaaS telemetry
 * @returns {boolean}
 */
function needsZTIWait() {
  if (process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI === 'false') return false

  const kind = cds.env.requires.telemetry?.kind
  if (!kind?.match(/to-caas$/)) return false

  const vcapServices = process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES)
  if (!vcapServices) return false

  for (const [key, services] of Object.entries(vcapServices)) {
    if (key === 'zero-trust-identity') return true
    for (const svc of services) {
      if (svc.tags?.includes('zero-trust-identity') || svc.label === 'zero-trust-identity') return true
    }
  }

  return false
}

module.exports = {
  initializeZTI,
  getZTIConfig,
  getCredsForCaaSMtls,
  needsZTIWait
}
