const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')

const SVID_DIR = '/home/vcap/app/spire-svids'

let _paths = null
let _cached = null
let _watcher = null
let _bootstrapWatcher = null

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

  const dir = require('path').dirname(_paths.cert)
  let debounce = null

  try {
    _watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && !filename.endsWith('.svid.pem')) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(reloadAndEmitSVID, 1000)
    })
  } catch (err) {
    // The SVID directory may not exist yet during the boot race (SPIRE writes it shortly after
    // startup). Watch the parent so we can arm the real watcher once the directory appears —
    // otherwise setup() reports async certs with no watcher left to ever deliver them, and
    // buffering exporters queue forever.
    if (err.code === 'ENOENT') startBootstrapWatcher(dir)
    else LOG._warn && LOG.warn('Failed to setup SVID watcher:', err)
  }
}

// Reload the SVID from disk into cds.env and announce it via the 'svid' event so the rotating
// agent hot-swaps and buffering exporters flush. Used for rotations and for the delayed initial
// load once the SVID files first appear.
function reloadAndEmitSVID() {
  try {
    _cached = null
    const creds = _getSVIDCertificate()
    if (!cds.env.requires.telemetry) cds.env.requires.telemetry = {}
    cds.env.requires.telemetry.x509 = { cert: creds.cert, key: creds.key }
    cds.emit('svid', { cert: creds.cert, key: creds.key })
    LOG._debug && LOG.debug('SVID certificate loaded')
  } catch (err) {
    LOG._error && LOG.error('Failed to reload SVID:', err)
  }
}

// Boot-race fallback: watch the (always-present) parent directory until the SVID directory is
// created, then hand off to the real watcher and pick up any files already written.
function startBootstrapWatcher(svidDir) {
  if (_bootstrapWatcher) return
  const path = require('path')
  const parent = path.dirname(svidDir)
  const base = path.basename(svidDir)
  let debounce = null

  try {
    _bootstrapWatcher = fs.watch(parent, (_eventType, filename) => {
      if (filename && filename !== base) return
      if (!fs.existsSync(svidDir)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        stopBootstrapWatcher()
        startSVIDWatcher() // directory now exists — arm the real watcher
        if (fs.existsSync(_paths.cert)) reloadAndEmitSVID() // files may already be present
      }, 500)
    })
  } catch (err) {
    LOG._warn && LOG.warn('Failed to setup SVID bootstrap watcher:', err)
  }
}

function stopSVIDWatcher() {
  if (_watcher) {
    _watcher.close()
    _watcher = null
  }
  stopBootstrapWatcher()
}

function stopBootstrapWatcher() {
  if (_bootstrapWatcher) {
    _bootstrapWatcher.close()
    _bootstrapWatcher = null
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
