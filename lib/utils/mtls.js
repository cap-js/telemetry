const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

// Generic HTTP mTLS transport for OTLP exporters. It is agnostic to where the client
// certificate comes from: it reads the current cert/key from cds.env and hot-swaps them
// whenever a cert source announces a rotation. ZTI is one such source, but static x509 or
// any future provider works the same way — the only contract is the 'svid' event + cds.env.

// True once a usable client certificate is present in cds.env, regardless of its source
// (ZTI-loaded or statically configured). Pure predicate: no I/O, no watcher side effects.
function certsAvailable() {
  return !!cds.env.requires?.telemetry?.x509?.cert
}

function decodeCredentials(creds) {
  if (creds.cert.startsWith('LS0t') || !creds.cert.startsWith('-----BEGIN')) {
    const cert = Buffer.from(creds.cert, 'base64').toString('utf-8')
    const key = Buffer.from(creds.key, 'base64').toString('utf-8')
    if (!cert.includes('-----BEGIN') || !key.includes('-----BEGIN')) {
      throw new Error('Decoded x509 cert or key is not valid PEM data')
    }
    return { cert, key }
  }
  return { cert: creds.cert, key: creds.key }
}

// Provision statically configured x509 credentials into cds.env, decoding base64 if needed.
// The static counterpart to ZTI cert sourcing; both feed the same cds.env.x509 slot that
// certsAvailable() and the rotating agent read. Cert provisioning is orchestrated once at
// startup (see lib/index.js); this is the non-ZTI fallback.
function setupStaticCerts() {
  const { x509 } = cds.env.requires.telemetry || {}
  if (!x509?.cert || !x509?.key) return false

  const { cert, key } = decodeCredentials(x509)
  cds.env.requires.telemetry.x509 = { cert, key }
  return true
}

let _RotatingCertAgent = null

function getRotatingCertAgentClass() {
  if (_RotatingCertAgent) return _RotatingCertAgent
  const https = require('https')

  _RotatingCertAgent = class RotatingCertAgent extends https.Agent {
    constructor() {
      const x509 = cds.env.requires.telemetry?.x509
      super({ keepAlive: true, cert: x509?.cert, key: x509?.key })
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
  return _RotatingCertAgent
}

let _rotatingAgent = null

function createRotatingAgent() {
  if (!_rotatingAgent) {
    const RotatingCertAgent = getRotatingCertAgentClass()
    _rotatingAgent = new RotatingCertAgent()
  }
  return _rotatingAgent
}

function getRotatingAgentFactory() {
  return () => createRotatingAgent()
}

function reset() {
  if (_rotatingAgent) {
    _rotatingAgent._cleanup()
    _rotatingAgent = null
  }
}

module.exports = {
  certsAvailable,
  setupStaticCerts,
  getRotatingAgentFactory,
  // exported for testing only (used internally within this module in production)
  getRotatingCertAgentClass,
  reset
}
