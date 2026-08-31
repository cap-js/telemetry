const cds = require('@sap/cds')
const LOG = cds.log('telemetry')
const fs = require('fs')
const https = require('https')

const SVID_DIR = '/home/vcap/app/spire-svids'

let _paths = null
let _cached = null

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

// HTTPS Agent with automatic certificate rotation via fs.watch
class RotatingCertAgent extends https.Agent {
  constructor(certPath) {
    super({ keepAlive: true })
    this._certPath = certPath
    this._initialized = false
    this._watcherSetup = false
  }

  _setupWatcher() {
    if (this._watcherSetup) return
    this._watcherSetup = true

    let debounce = null
    const dir = require('path').dirname(this._certPath)

    try {
      fs.watch(dir, (_eventType, filename) => {
        if (filename && !filename.endsWith('.svid.pem')) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => this._rotate(), 1000)
      })
    } catch (err) {
      LOG._warn && LOG.warn('Failed to setup certificate watcher:', err)
    }
  }

  _ensureInitialized() {
    if (this._initialized) return true

    try {
      this.options.cert = getCert()
      this.options.key = getKey()
      this._initialized = true
      if (!this._watcherSetup) this._setupWatcher()
      return true
    } catch (err) {
      return false
    }
  }

  createConnection(options, callback) {
    if (!this._ensureInitialized()) {
      const err = new Error('ZTI certificate not available yet')
      err.code = 'CERT_NOT_READY'
      if (callback) {
        process.nextTick(() => callback(err))
        return
      }
      throw err
    }
    return super.createConnection(options, callback)
  }

  _rotate() {
    try {
      _cached = null
      this.options.cert = getCert()
      this.options.key = getKey()
      this._initialized = true
      this.destroy()
    } catch (err) {
      LOG._error && LOG.error('Failed to rotate certificate:', err)
    }
  }
}

let _rotatingAgent = null

function createRotatingAgent() {
  if (!_paths) throw new Error('ZTI not initialized')
  if (!_rotatingAgent) _rotatingAgent = new RotatingCertAgent(_paths.cert)
  return _rotatingAgent
}

function getRotatingAgentFactory() {
  return () => createRotatingAgent()
}

// For testing
function _reset() {
  _paths = null
  _cached = null
  if (_rotatingAgent) {
    _rotatingAgent.destroy()
    _rotatingAgent = null
  }
}

module.exports = {
  getZTIConfig,
  initializeZTI,
  isZTIEnabled,
  getCert,
  getKey,
  getRotatingAgentFactory,
  _reset
}
