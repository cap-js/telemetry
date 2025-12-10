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
    const cstm_env = getEnvWithoutDefaults()
    const otlp_env = getEnv()
    let protocol = cstm_env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? cstm_env.OTEL_EXPORTER_OTLP_PROTOCOL
    // on kyma, the otlp endpoint speaks grpc, but otel's default protocol is http/protobuf -> fix default
    if (!protocol) {
      const endpoint = otlp_env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? otlp_env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ''
      if (endpoint.match(/:4317/)) protocol = 'grpc'
    }
    protocol ??= otlp_env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? otlp_env.OTEL_EXPORTER_OTLP_PROTOCOL
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
  if (loggerProvider.constructor.name === 'ProxyLoggerProvider') {
    loggerProvider = new LoggerProvider({ resource })
    logs.setGlobalLoggerProvider(loggerProvider)
  } else {
    LOG._warn && LOG.warn('LoggerProvider already initialized by a different module. It will be used as is.')
  }

  const exporter = _getExporter()

  const logProcessor =
    _getCustomProcessor(exporter) ||
    (process.env.NODE_ENV === 'production'
      ? new BatchLogRecordProcessor(exporter)
      : new SimpleLogRecordProcessor(exporter))
  loggerProvider.addLogRecordProcessor(logProcessor)

  cds.on('served', () => {
    const loggers = {}
    const l2s = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'DEBUG', 5: 'TRACE' }

    const custom_fields = cds.env.log.cls_custom_fields || []

    // intercept logs via format
    const { format: _format } = cds.log
    const format = (cds.log.format = function (module, level, ...args) {
      const res = _format.call(this, module, level, ...args)

      let log
      try {
        log = res.length === 1 && res[0].startsWith?.('{"') && JSON.parse(res[0])
      } catch {
        // ignore
      }
      if (log) {
        const logger = loggers[module] || (loggers[module] = loggerProvider.getLogger(module))
        const severity = l2s[level]
        const attributes = {
          'log.type': 'LogRecord'
        }
        let e = args.find(a => a instanceof Error)
        if (e) {
          attributes['exception.message'] = e.message
          attributes['exception.stacktrace'] = e.stack
          attributes['exception.type'] = e.name
          // remove stack from message, if present
          // NOTE: an error should always have a stack, but there was an issue report where it somehow was undefined
          log.msg = log.msg.replace(e.stack, e.stack?.split('\n')[0])
        }
        for (const field of custom_fields) if (field in log) attributes[field] = log[field]
        logger.emit({
          severityNumber: SeverityNumber[severity],
          severityText: severity,
          body: log.msg,
          attributes
        })
      }

      return res
    })

    // replace format function of existing loggers
    for (const each in cds.log.loggers) cds.log.loggers[each].setFormat(format)
  })

  return loggerProvider
}
