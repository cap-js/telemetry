const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

// SVID paths and cached credentials (initialized once, reused across requests)
let _paths = null // { cert, key, bundle } - file paths
let _cached = null // { cert, key, bundle, mtime } - cached credentials

/**
 * Check if SVID files exist (sync)
 * @returns {boolean}
 */
function _svidFilesExist() {
  if (!_paths) return false
  try {
    fs.statSync(_paths.cert)
    fs.statSync(_paths.key)
    fs.statSync(_paths.bundle)
    return true
  } catch {
    return false
  }
}

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
 * Initialize SVID file paths (does NOT wait for files to exist)
 * Called internally when credentials are first requested.
 * @param {string} svidDir - Directory containing SVID files
 * @param {string} svidName - SVID file base name
 */
function _initializePaths(svidDir, svidName) {
  if (_paths) return // Already initialized
  _paths = {
    cert: `${svidDir}/${svidName}.svid.pem`,
    key: `${svidDir}/${svidName}.svid.key`,
    bundle: `${svidDir}/${svidName}.bundle.pem`
  }
}

/**
 * Get mTLS credentials for CaaS telemetry
 * Priority:
 *   1. ZTI file-based (default, automatic rotation) - if USE_ZTI=true (default)
 *   2. Env var base64 (legacy, manual rotation) - if USE_ZTI=false
 *
 * Returns null if ZTI is configured but SVID files don't exist yet.
 * The LazyExporter will buffer telemetry until credentials become available.
 *
 * @returns {{ cert: string, key: string } | null}
 */
function getCredsForCaaSMtls() {
  // Check flag: default to ZTI (only disable if explicitly set to 'false')
  const useZTI = process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI !== 'false'

  if (useZTI) {
    // ZTI approach (default)
    const ztiConfig = getZTIConfig()
    if (ztiConfig) {
      // ZTI binding found - initialize paths if needed
      _initializePaths(ztiConfig.svidDir, ztiConfig.svidName)

      // Check if SVID files exist
      if (!_svidFilesExist()) {
        LOG._debug && LOG.debug('ZTI: SVID files not ready yet, will buffer telemetry')
        return null
      }

      // Files exist - get credentials (with mtime-based caching for rotation)
      try {
        const { cert, key } = _getSVIDCertificate()
        return { cert, key }
      } catch (err) {
        LOG._error && LOG.error('ZTI: Failed to load SVID credentials:', err)
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

module.exports = {
  getZTIConfig,
  getCredsForCaaSMtls
}
