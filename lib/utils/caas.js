const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { augmentCaaSCreds } = require('./credentials')
const { certsAvailable } = require('./mtls')

const MAX_BUFFER_SIZE = Number(process.env.TELEMETRY_MAX_BUFFER_SIZE ?? 10)

function wrapExporterWithBuffer(exporter) {
  const buffer = []
  let ready = false
  const originalExport = exporter.export.bind(exporter)

  exporter.export = function (items, callback) {
    if (!ready) {
      if (certsAvailable()) {
        ready = true
        if (buffer.length > 0) {
          LOG._debug && LOG.debug(`Flushing ${buffer.length} buffered items`)
          for (const buffered of buffer) {
            originalExport(buffered, () => {})
          }
          buffer.length = 0
        }
        // Restore original export for all future calls
        exporter.export = originalExport
        return originalExport(items, callback)
      }
      // Not ready yet — buffer this export batch. MAX_BUFFER_SIZE caps the
      // number of pending batches (not records). The batch is ack'd as success
      // to the SDK now; if certs never arrive, buffered batches are dropped.
      if (buffer.length >= MAX_BUFFER_SIZE) {
        buffer.shift()
        LOG._warn && LOG.warn('Buffer full, dropping oldest batch')
      }
      buffer.push(items)
      callback({ code: 0 })
      return
    }
    return originalExport(items, callback)
  }

  return exporter
}

function createCaaSExporter(credentials, config, signalPath, createExporterFn) {
  if (!credentials) throw new Error('No CaaS credentials found.')

  augmentCaaSCreds(credentials)

  // Whether ZTI is the active cert source is decided once at startup (lib/index.js). When it
  // is, certs may still be arriving asynchronously, so a missing cert is not (yet) an error.
  const useZTI = cds.env.requires.telemetry?._useZTI ?? false

  if (!certsAvailable() && !useZTI) {
    throw new Error('CaaS requires mTLS. Bind zero-trust-identity service or configure x509 credentials.')
  }

  const exporterConfig = {
    ...config,
    url: credentials.baseUrl + signalPath,
    httpAgentOptions: credentials.httpAgentOptions
  }

  let exporter = createExporterFn(exporterConfig)

  // If ZTI and certs not yet available, wrap with buffering until the watcher delivers them
  if (useZTI && !certsAvailable()) exporter = wrapExporterWithBuffer(exporter)

  return exporter
}

module.exports = {
  createCaaSExporter,
  // exported for testing only (reached in production via createCaaSExporter)
  wrapExporterWithBuffer
}
