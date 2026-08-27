const cds = require('@sap/cds')

const MAX_BUFFER_SIZE = 1000

function _tryCreateExporter(state, createExporter, LOG) {
  if (state._exporter) return
  if (state._createFailed) return

  const result = createExporter()

  // Transient: credentials not ready yet, will retry
  if (result.status === 'not_ready') return

  // Permanent: configuration error, stop retrying
  if (result.status === 'error') {
    LOG._warn && LOG.warn('Lazy exporter: failed to create exporter:', result.error)
    state._createFailed = true
    return
  }

  // Success
  state._exporter = result.exporter
}

function _flushBuffer(state) {
  if (state._buffer.length === 0 || !state._exporter) return

  const buffered = state._buffer
  state._buffer = []

  for (const item of buffered) {
    if (Array.isArray(item)) {
      state._exporter.export(item, () => {})
    } else {
      state._exporter.export(item, () => {})
    }
  }
}

// Buffers telemetry until mTLS credentials are available (for CaaS with ZTI)
function createLazyExporter(createExporter, options = {}) {
  const LOG = cds.log('telemetry')
  const maxBufferSize = options.maxBufferSize || MAX_BUFFER_SIZE

  const state = {
    _exporter: null,
    _buffer: [],
    _createFailed: false
  }

  return {
    export(items, resultCallback) {
      _tryCreateExporter(state, createExporter, LOG)

      if (state._exporter) {
        _flushBuffer(state)
        state._exporter.export(items, resultCallback)
      } else {
        if (state._buffer.length >= maxBufferSize) {
          state._buffer.shift()
          LOG._warn && LOG.warn('Lazy exporter: buffer full, dropping telemetry')
        }
        state._buffer.push(items)
        resultCallback({ code: 0 })
      }
    },

    shutdown() {
      state._buffer = []
      return state._exporter?.shutdown() ?? Promise.resolve()
    },

    forceFlush() {
      _tryCreateExporter(state, createExporter, LOG)
      if (state._exporter) {
        _flushBuffer(state)
        return state._exporter.forceFlush?.() ?? Promise.resolve()
      }
      return Promise.resolve()
    },

    _getBufferSize() {
      return state._buffer.length
    },

    _isExporterCreated() {
      return state._exporter !== null
    }
  }
}

module.exports = { createLazyExporter }
