const cds = require('@sap/cds')

/**
 * Creates a lazy wrapper for any OTLP exporter.
 * Buffers data until mTLS credentials are available.
 *
 * This is used for CaaS (Collector as a Service) with ZTI (Zero Trust Identity)
 * where SPIRE sidecar provisions SVID files in parallel with app startup -
 * they may not exist when the app starts.
 *
 * @param {Function} createExporter - Factory that creates the real exporter (may throw if creds not ready)
 * @param {Object} options - { maxBufferSize: number }
 * @returns {Object} Exporter-like object with export(), shutdown(), forceFlush() methods
 */
function createLazyExporter(createExporter, options = {}) {
  const LOG = cds.log('telemetry')

  let _exporter = null
  let _buffer = []
  let _createFailed = false
  const _maxBufferSize = options.maxBufferSize || 1000

  function _tryCreateExporter() {
    if (_exporter) return _exporter
    if (_createFailed) return null // Don't retry after permanent failure

    try {
      _exporter = createExporter()
      LOG._debug && LOG.debug('Lazy exporter: real exporter created successfully')
      return _exporter
    } catch (err) {
      // Check if this is a "credentials not ready" error vs a permanent failure
      if (err.message?.includes('SVID') || err.code === 'ENOENT') {
        // Credentials not ready yet - will retry on next export
        LOG._debug && LOG.debug('Lazy exporter: credentials not ready yet, buffering')
        return null
      }
      // Permanent failure - don't retry
      LOG._warn && LOG.warn('Lazy exporter: permanent failure creating exporter:', err.message)
      _createFailed = true
      return null
    }
  }

  function _flushBuffer() {
    if (_buffer.length === 0 || !_exporter) return

    const buffered = _buffer
    _buffer = []
    LOG._debug && LOG.debug(`Lazy exporter: flushing ${buffered.length} buffered items`)

    // Best effort flush - don't wait for callback
    // For traces/logs (arrays), we need to flatten
    // For metrics (ResourceMetrics objects), export each separately
    for (const item of buffered) {
      if (Array.isArray(item)) {
        _exporter.export(item, () => {})
      } else {
        _exporter.export(item, () => {})
      }
    }
  }

  return {
    export(items, resultCallback) {
      _tryCreateExporter()

      if (_exporter) {
        _flushBuffer()
        _exporter.export(items, resultCallback)
      } else {
        // Buffer items
        if (_buffer.length >= _maxBufferSize) {
          // Drop oldest to make room
          _buffer.shift()
          LOG._debug && LOG.debug('Lazy exporter: buffer full, dropping oldest item')
        }
        _buffer.push(items)
        // Report success - we buffered it
        resultCallback({ code: 0 })
      }
    },

    shutdown() {
      _buffer = []
      return _exporter?.shutdown() ?? Promise.resolve()
    },

    forceFlush() {
      _tryCreateExporter()
      if (_exporter) {
        _flushBuffer()
        return _exporter.forceFlush?.() ?? Promise.resolve()
      }
      return Promise.resolve()
    },

    // For testing
    _getBufferSize() {
      return _buffer.length
    },

    _isExporterCreated() {
      return _exporter !== null
    }
  }
}

module.exports = { createLazyExporter }
