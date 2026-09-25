const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { augmentCaaSCreds } = require('./credentials')
const { certsAvailable } = require('./mtls')

const MAX_BUFFER_SIZE = Number(process.env.TELEMETRY_MAX_BUFFER_SIZE ?? 10)

function wrapExporterWithBuffer(exporter) {
  const buffer = []
  const originalExport = exporter.export.bind(exporter)

  exporter.export = function (items, callback) {
    if (certsAvailable()) {
      if (buffer.length > 0) {
        LOG._debug && LOG.debug(`Flushing ${buffer.length} buffered items`)
        for (const buffered of buffer) {
          originalExport(buffered, () => {})
        }
        buffer.length = 0
      }
      // Certs have arrived: drop the buffering wrapper so all future exports go straight through.
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
  }

  return exporter
}

function createCaaSExporter(credentials, config, signalPath, createExporterFn) {
  if (!credentials) throw new Error('No CaaS credentials found.')

  augmentCaaSCreds(credentials)

  // Whether certs arrive asynchronously (ZTI SVID files, possibly after startup) is decided once
  // at startup (lib/index.js). If so, a missing cert now is expected — it will arrive via the
  // watcher — so we buffer instead of failing. Otherwise a missing cert is a hard misconfiguration.
  const asyncCerts = cds.env.requires.telemetry?._asyncCerts ?? false

  if (!certsAvailable() && !asyncCerts) {
    throw new Error('CaaS requires mTLS. Bind zero-trust-identity service or configure x509 credentials.')
  }

  const exporterConfig = {
    ...config,
    url: credentials.baseUrl + signalPath,
    httpAgentOptions: credentials.httpAgentOptions
  }

  let exporter = createExporterFn(exporterConfig)

  // Certs not yet available but arriving async: buffer exports until the watcher delivers them
  if (asyncCerts && !certsAvailable()) exporter = wrapExporterWithBuffer(exporter)

  return exporter
}

module.exports = {
  createCaaSExporter,
  // exported for testing only (reached in production via createCaaSExporter)
  wrapExporterWithBuffer
}
