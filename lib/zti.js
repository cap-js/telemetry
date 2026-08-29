const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

const SVID_DIR = '/home/vcap/app/spire-svids'

let _paths = null
let _cached = null

function _getSVIDCertificate() {
  if (!_paths) throw new Error('ZTI paths not initialized')

  let stat
  try {
    stat = fs.statSync(_paths.cert)
  } catch (e) {
    // Transient stat failure during atomic rename - serve last-known-good
    if (_cached) {
      LOG._debug && LOG.debug('Stat failure, serving cached credentials')
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
      LOG._warn && LOG.warn('Failed to reload SVID files, serving cached:', err)
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
    LOG._warn && LOG.warn('zero-trust-identity binding missing svid-store.file.name')
    return null
  }

  const svidDir = process.env.CDS_REQUIRES_TELEMETRY_ZTI_DIR || SVID_DIR
  return { svidDir, svidName }
}

function initializeZTI() {
  const config = getZTIConfig()
  if (!config) return false

  _paths = {
    cert: `${config.svidDir}/${config.svidName}.svid.pem`,
    key: `${config.svidDir}/${config.svidName}.svid.key`,
    bundle: `${config.svidDir}/${config.svidName}.bundle.pem`
  }
  return true
}

function isZTIEnabled() {
  return process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI !== 'false'
}

function getCert() {
  return _getSVIDCertificate().cert
}

function getKey() {
  return _getSVIDCertificate().key
}

// For testing
function _reset() {
  _paths = null
  _cached = null
}

module.exports = {
  getZTIConfig,
  initializeZTI,
  isZTIEnabled,
  getCert,
  getKey,
  _reset
}
