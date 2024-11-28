const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { getEnv, getEnvWithoutDefaults } = require('@opentelemetry/core')

const { getCredsForCLSAsUPS, augmentCLCreds, _require } = require('../utils')

const _protocol2module = {
  grpc: '@opentelemetry/exporter-logs-otlp-grpc',
  'http/protobuf': '@opentelemetry/exporter-logs-otlp-proto',
  'http/json': '@opentelemetry/exporter-logs-otlp-http'
}

function _getExporter() {
  let {
    kind,
    logging: { exporter: loggingExporter },
    credentials
  } = cds.env.requires.telemetry

  // for kind telemetry-to-otlp based on env vars
  if (loggingExporter === 'env') {
    const otlp_env = getEnvWithoutDefaults()
    const dflt_env = getEnv()
    const protocol =
      otlp_env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ??
      otlp_env.OTEL_EXPORTER_OTLP_PROTOCOL ??
      dflt_env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ??
      dflt_env.OTEL_EXPORTER_OTLP_PROTOCOL
    loggingExporter = { module: _protocol2module[protocol], class: 'OTLPLogExporter' }
  }

  // use _require for better error message
  const loggingExporterModule = _require(loggingExporter.module)
  if (!loggingExporterModule[loggingExporter.class])
    throw new Error(`Unknown logs exporter "${loggingExporter.class}" in module "${loggingExporter.module}"`)
  const config = { ...(loggingExporter.config || {}) }

  if (kind.match(/to-cloud-logging$/)) {
    if (!credentials) credentials = getCredsForCLSAsUPS()
    if (!credentials) throw new Error('No SAP Cloud Logging credentials found.')
    augmentCLCreds(credentials)
    config.url ??= credentials.url
    config.credentials ??= credentials.credentials
  }

  const exporter = new loggingExporterModule[loggingExporter.class](config)
  LOG._debug && LOG.debug('Using logs exporter:', exporter)

  return exporter
}

function _getCustomProcessor(exporter) {
  let {
    logging: { processor: loggingProcessor }
  } = cds.env.requires.telemetry

  if (!loggingProcessor) return

  // use _require for better error message
  const loggingProcessorModule = _require(loggingProcessor.module)
  if (!loggingProcessorModule[loggingProcessor.class])
    throw new Error(`Unknown logs processor "${loggingProcessor.class}" in module "${loggingProcessor.module}"`)

  const processor = new loggingProcessorModule[loggingProcessor.class](exporter)
  LOG._debug && LOG.debug('Using logs processor:', processor)

  return processor
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.logging?.exporter) return

  const { logs, SeverityNumber } = require('@opentelemetry/api-logs')
  const { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs')

  let loggerProvider = logs.getLoggerProvider()
  if (!loggerProvider.getDelegateLogger()) {
    loggerProvider = new LoggerProvider({ resource })
    logs.setGlobalLoggerProvider(loggerProvider)
  } else {
    LOG._warn && LOG.warn('LoggerProvider already initialized by a different module. It will be used as is.')
    loggerProvider = loggerProvider.getDelegateLogger()
  }

  const exporter = _getExporter()

  const logProcessor =
    _getCustomProcessor(exporter) ||
    (process.env.NODE_ENV === 'production'
      ? new BatchLogRecordProcessor(exporter)
      : new SimpleLogRecordProcessor(exporter))
  loggerProvider.addLogRecordProcessor(logProcessor)

  const loggers = {}
  const l2s = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'DEBUG', 5: 'TRACE' }

  // intercept logs via format
  const { format } = cds.log
  cds.log.format = (module, level, ...args) => {
    const res = format(module, level, ...args)

    let log
    try {
      log = res.length === 1 && res[0].startsWith?.('{"') && JSON.parse(res[0])
    } catch {
      // ignore
    }
    if (log) {
      const logger = loggers[module] || (loggers[module] = loggerProvider.getLogger(module))
      const severity = l2s[level]
      // TODO: what to log?
      logger.emit({
        severityNumber: SeverityNumber[severity],
        severityText: severity,
        body: log.msg,
        attributes: { 'log.type': 'LogRecord' }
      })
    }

    return res
  }

  // clear cached loggers
  cds.log.loggers = {}

  return loggerProvider
}
