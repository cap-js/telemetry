const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

// SVID file paths and cache (initialized once, reused across requests)
let _certPath = null
let _keyPath = null
let _bundlePath = null
let _cached = null
let _cachedMod = null

/**
 * Get SVID certificate credentials, reloading if mtime changed.
 * Manages mtime-based caching for automatic certificate rotation.
 * Based on official ZTI blueprint: https://github.tools.sap/pse/blueprints
 * @returns {{ cert: string, key: string, bundle: string }}
 */
function _getSVIDCertificate() {
  let stat
  try {
    stat = fs.statSync(_certPath)
  } catch (e) {
    // Transient stat failure during atomic rename - serve last-known-good
    if (_cached) {
      LOG._debug && LOG.debug('ZTI: Transient stat failure, serving cached credentials')
      return _cached
    }
    throw e
  }

  const mtime = stat.mtimeMs
  if (_cached && _cachedMod === mtime) {
    // Cache hit - no rotation since last check
    return _cached
  }

  // mtime changed or first load - reload all files atomically
  LOG._debug && LOG.debug('ZTI: Loading SVID files (mtime changed or first load)')
  try {
    const certPEM = fs.readFileSync(_certPath, 'utf8')
    const keyPEM = fs.readFileSync(_keyPath, 'utf8')
    const bundlePEM = fs.readFileSync(_bundlePath, 'utf8')

    _cached = { cert: certPEM, key: keyPEM, bundle: bundlePEM }
    _cachedMod = mtime

    LOG._info && LOG.info('ZTI: Loaded SVID certificate', {
      certPath: _certPath,
      mtime: new Date(mtime).toISOString()
    })

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
  const RETRY_INTERVAL_MS = 2000
  const MAX_RETRIES = 30 // 60 seconds total (30 * 2s)

  _certPath = `${svidDir}/${svidName}.svid.pem`
  _keyPath = `${svidDir}/${svidName}.svid.key`
  _bundlePath = `${svidDir}/${svidName}.bundle.pem`

  let attempt = 0
  while (true) {
    try {
      // Try to load - will throw if files don't exist
      _getSVIDCertificate()
      LOG._info && LOG.info(`ZTI: SVID files ready at ${svidDir}/${svidName}`)
      return
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

// For testing only - not part of public API
if (process.env.NODE_ENV === 'test') {
  module.exports._resetZTIState = () => {
    _certPath = null
    _keyPath = null
    _bundlePath = null
    _cached = null
    _cachedMod = null
    _ztiInitialized = false
    _ztiInitPromise = null
  }
}
