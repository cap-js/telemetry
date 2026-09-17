const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

const SVID_DIR = '/home/vcap/app/spire-svids'

let _paths = null
let _cached = null
let _watcher = null

function _getSVIDCertificate() {
  if (!_paths) throw new Error('ZTI paths not initialized')

  let stat
  try {
    stat = fs.statSync(_paths.cert)
  } catch (e) {
    if (_cached) {
      LOG._debug && LOG.debug('Stat failure, serving cached credentials')
      return _cached
    }
    throw e
  }

  const mtime = stat.mtimeMs
  if (_cached?.mtime === mtime) return _cached

  try {
    _cached = {
      cert: fs.readFileSync(_paths.cert, 'utf8'),
      key: fs.readFileSync(_paths.key, 'utf8'),
      bundle: fs.readFileSync(_paths.bundle, 'utf8'),
      mtime
    }
    return _cached
  } catch (err) {
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

  const svidDir = process.env.TELEMETRY_ZTI_DIR || SVID_DIR
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

function loadInitialCerts() {
  if (!_paths) return false
  try {
    const creds = _getSVIDCertificate()
    if (!cds.env.requires.telemetry) cds.env.requires.telemetry = {}
    cds.env.requires.telemetry.x509 = { cert: creds.cert, key: creds.key }
    return true
  } catch {
    return false
  }
}

// One-shot startup provisioning: if a zero-trust-identity service is bound, ZTI is the cert
// source — load the initial SVID into cds.env and start watching for rotations. Returns whether
// ZTI is active, independent of whether certs are present yet, since they may arrive
// asynchronously (SPIRE may write the SVID files shortly after startup).
function setup() {
  if (!initializeZTI()) return false
  loadInitialCerts()
  startSVIDWatcher()
  return true
}

function startSVIDWatcher() {
  if (_watcher) return // already watching
  if (!_paths) throw new Error('ZTI not initialized')

  let debounce = null
  const dir = require('path').dirname(_paths.cert)

  try {
    _watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && !filename.endsWith('.svid.pem')) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        try {
          _cached = null
          const creds = _getSVIDCertificate()
          if (!cds.env.requires.telemetry) cds.env.requires.telemetry = {}
          cds.env.requires.telemetry.x509 = { cert: creds.cert, key: creds.key }
          cds.emit('svid', { cert: creds.cert, key: creds.key })
          LOG._debug && LOG.debug('SVID certificate rotated')
        } catch (err) {
          LOG._error && LOG.error('Failed to reload SVID on rotation:', err)
        }
      }, 1000)
    })
  } catch (err) {
    LOG._warn && LOG.warn('Failed to setup SVID watcher:', err)
  }
}

function stopSVIDWatcher() {
  if (_watcher) {
    _watcher.close()
    _watcher = null
  }
}

function reset() {
  _paths = null
  _cached = null
  stopSVIDWatcher()
}

module.exports = {
  setup,
  loadInitialCerts,
  // exported for testing only (used internally within this module in production)
  initializeZTI,
  getZTIConfig,
  reset
}
