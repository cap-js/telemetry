const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')
const https = require('https')

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

function certsAvailable() {
  if (cds.env.requires.telemetry?.x509?.cert) return true
  if (!loadInitialCerts()) return false
  startSVIDWatcher()
  return true
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

// OTel caches the agent instance, so we need to update certs in place and kill pooled sockets
class RotatingCertAgent extends https.Agent {
  constructor() {
    const x509 = cds.env.requires.telemetry?.x509
    if (!x509?.cert || !x509?.key) {
      throw new Error('No x509 credentials in cds.env.requires.telemetry.x509')
    }
    super({ keepAlive: true, cert: x509.cert, key: x509.key })
    this._boundRotate = this._rotate.bind(this)
    cds.on('svid', this._boundRotate)
  }

  _rotate(payload) {
    try {
      const { cert, key } = payload ?? cds.env.requires.telemetry?.x509 ?? {}
      if (!cert || !key) {
        LOG._warn && LOG.warn('RotatingCertAgent: no credentials in event payload or cds.env')
        return
      }
      this.options.cert = cert
      this.options.key = key
      this.destroy()
      LOG._debug && LOG.debug('Certificate rotated')
    } catch (err) {
      LOG._error && LOG.error('Failed to rotate certificate:', err)
    }
  }

  _cleanup() {
    cds.off('svid', this._boundRotate)
    this.destroy()
  }
}

let _rotatingAgent = null

function createRotatingAgent() {
  if (!_rotatingAgent) _rotatingAgent = new RotatingCertAgent()
  return _rotatingAgent
}

function getRotatingAgentFactory() {
  return () => createRotatingAgent()
}

function reset() {
  _paths = null
  _cached = null
  stopSVIDWatcher()
  if (_rotatingAgent) {
    _rotatingAgent._cleanup()
    _rotatingAgent = null
  }
}

module.exports = {
  getZTIConfig,
  initializeZTI,
  isZTIEnabled,
  loadInitialCerts,
  certsAvailable,
  startSVIDWatcher,
  stopSVIDWatcher,
  getRotatingAgentFactory,
  RotatingCertAgent,
  reset
}
