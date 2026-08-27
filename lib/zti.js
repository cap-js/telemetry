const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

let _paths = null
let _cached = null

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

function _getSVIDCertificate() {
  let stat
  try {
    stat = fs.statSync(_paths.cert)
  } catch (e) {
    // Transient stat failure during atomic rename - serve last-known-good
    if (_cached) {
      LOG._debug && LOG.debug('ZTI: stat failure, serving cached credentials')
      return _cached
    }
    throw e
  }

  const mtime = stat.mtimeMs
  if (_cached?.mtime === mtime) return _cached

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
      LOG._warn && LOG.warn('ZTI: failed to reload SVID files, serving cached', err)
      return _cached
    }
    throw err
  }
}

function getZTIConfig() {
  if (!process.env.VCAP_SERVICES) return null

  const vcap = JSON.parse(process.env.VCAP_SERVICES)
  const zti = vcap['zero-trust-identity']
  if (!zti || zti.length === 0) return null

  const svidName = zti[0].credentials?.parameters?.['svid-store']?.file?.name
  if (!svidName) {
    LOG._warn && LOG.warn('ZTI: zero-trust-identity binding missing svid-store.file.name')
    return null
  }

  let svidDir = process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR
  if (!svidDir) {
    const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
    svidDir = isDocker ? '/etc/ztis/spire/svids' : '/home/vcap/app/spire-svids'
  }

  return { svidDir, svidName }
}

function _initializePaths(svidDir, svidName) {
  if (_paths) return // Already initialized
  _paths = {
    cert: `${svidDir}/${svidName}.svid.pem`,
    key: `${svidDir}/${svidName}.svid.key`,
    bundle: `${svidDir}/${svidName}.bundle.pem`
  }
}

// Returns null if not configured, false if not ready yet
function getZTICredentials() {
  const useZTI = process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI !== 'false'
  if (!useZTI) return null

  const ztiConfig = getZTIConfig()
  if (!ztiConfig) return null

  _initializePaths(ztiConfig.svidDir, ztiConfig.svidName)

  if (!_svidFilesExist()) return false

  try {
    const { cert, key } = _getSVIDCertificate()
    return { cert, key }
  } catch (err) {
    LOG._error && LOG.error('ZTI: failed to load SVID credentials:', err)
    return false
  }
}

module.exports = {
  getZTIConfig,
  getZTICredentials
}
