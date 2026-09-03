const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const MAX_BUFFER_SIZE = 1000

// Buffers telemetry until credentials are available (for CaaS with ZTI)
function createLazyExporter(createExporter) {
  let _exporter = null
  let _buffer = []
  let _failed = false

  function _tryCreate() {
    if (_exporter || _failed) return _exporter

    const result = createExporter()
    if (result.status === 'not_ready') return null
    if (result.status === 'error') {
      LOG._warn && LOG.warn('LazyExporter: permanent failure:', result.error)
      _failed = true
      return null
    }

    _exporter = result.exporter
    return _exporter
  }

  function _flush() {
    if (!_exporter || _buffer.length === 0) return
    const items = _buffer
    _buffer = []
    LOG._debug && LOG.debug(`LazyExporter: flushing ${items.length} buffered items`)
    for (const item of items) {
      _exporter.export(item, () => {})
    }
  }

  return {
    export(items, callback) {
      _tryCreate()

      if (_exporter) {
        _flush()
        _exporter.export(items, callback)
      } else if (!_failed) {
        if (_buffer.length >= MAX_BUFFER_SIZE) {
          _buffer.shift()
          LOG._warn && LOG.warn('LazyExporter: buffer full, dropping oldest item')
        }
        _buffer.push(items)
        callback({ code: 0 })
      } else {
        callback({ code: 1, error: new Error('Exporter creation failed') })
      }
    },

    shutdown() {
      _buffer = []
      return _exporter?.shutdown() ?? Promise.resolve()
    },

    forceFlush() {
      _tryCreate()
      _flush()
      return _exporter?.forceFlush?.() ?? Promise.resolve()
    },

    selectAggregationTemporality(instrumentType) {
      if (_exporter?.selectAggregationTemporality) {
        return _exporter.selectAggregationTemporality(instrumentType)
      }
      // UP_DOWN_COUNTER requires CUMULATIVE, all others use DELTA
      return instrumentType === 'UP_DOWN_COUNTER' || instrumentType === 'OBSERVABLE_UP_DOWN_COUNTER' ? 1 : 0
    }
  }
}

module.exports = { createLazyExporter }
