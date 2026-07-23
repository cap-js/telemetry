const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

// ensure http and https are wrapped
require('http')
require('https')

const path = require('path')

const { diag } = require('@opentelemetry/api')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')

const tracing = require('./tracing')
const metrics = require('./metrics')
const logging = require('./logging')
const { getDiagLogLevel, getResource, hasCalmSupport, _require } = require('./utils')

function _getInstrumentations() {
  const _instrumentations = cds.env.requires.telemetry.instrumentations

  // if @opentelemetry/instrumentation-runtime-node is in project's dependencies but not in cds.env.requires.telemetry.instrumentations, add it automatically
  if (
    !Object.keys(_instrumentations).includes('instrumentation-runtime-node') &&
    !Object.values(_instrumentations).find(i => i?.module === '@opentelemetry/instrumentation-runtime-node')
  ) {
    try {
      const pkg = require(require('path').join(cds.root, 'package'))
      if (Object.keys(pkg.dependencies).includes('@opentelemetry/instrumentation-runtime-node')) {
        _instrumentations['instrumentation-runtime-node'] = {
          class: 'RuntimeNodeInstrumentation',
          module: '@opentelemetry/instrumentation-runtime-node'
        }
      }
    } catch (err) {
      LOG._debug && LOG.debug('Failed to automatically add @opentelemetry/instrumentation-runtime-node:', err)
    }
  }

  // if @opentelemetry/instrumentation-host-metrics is in project's dependencies but not in cds.env.requires.telemetry.instrumentations, add it automatically
  if (
    !Object.keys(_instrumentations).includes('instrumentation-host-metrics') &&
    !Object.values(_instrumentations).find(i => i?.module === '@opentelemetry/instrumentation-host-metrics')
  ) {
    try {
      const pkg = require(require('path').join(cds.root, 'package'))
      if (Object.keys(pkg.dependencies).includes('@opentelemetry/instrumentation-host-metrics')) {
        _instrumentations['instrumentation-host-metrics'] = {
          class: 'HostMetricsInstrumentation',
          module: '@opentelemetry/instrumentation-host-metrics'
        }
      }
    } catch (err) {
      LOG._debug && LOG.debug('Failed to automatically add @opentelemetry/instrumentation-host-metrics:', err)
    }
  }

  // by default, all `system.*` metrics shall be ignored
  const host_metrics = Object.values(_instrumentations).find(
    i => i?.module === '@opentelemetry/instrumentation-host-metrics'
  )
  if (host_metrics && !host_metrics.config?.metricGroups && !process.env.HOST_METRICS_RETAIN_SYSTEM) {
    host_metrics.config ??= {}
    host_metrics.config.metricGroups = ['process.cpu', 'process.memory']
  }

  const instrumentations = []
  for (const each of Object.values(_instrumentations)) {
    if (!each) continue //> could be falsy
    const module = _require(each.module)
    if (!module[each.class]) throw new Error(`Unknown instrumentation "${each.class}" in module "${each.module}"`)
    const config = { ...(each.config || {}) }
    const hooks = Object.keys(config).filter(k => k.match(/^\w+Hook$/))
    for (const hook of hooks) {
      if (typeof config[hook] === 'string') {
        try {
          const _module = require(path.join(cds.root, config[hook]))
          if (typeof _module === 'function') config[hook] = _module
          else if (typeof _module[hook] === 'function') config[hook] = _module[hook]
          else throw new Error(`${config[hook]} must either export a function or an object with a function "${hook}"`)
        } catch (err) {
          LOG._warn && LOG.warn(`Failed to load hook "${hook}" for module "${each.module}":`, err)
        }
      }
    }
    const instrumentation = new module[each.class](config)
    instrumentations.push(instrumentation)
  }

  return instrumentations
}

function setup_standalone() {
  // set logger and propagate log level
  diag.setLogger(cds.log('telemetry'), getDiagLogLevel())

  // create resource
  const resource = getResource()

  // setup tracing, metrics, and logging
  const tracerProvider = tracing(resource)
  const meterProvider = metrics(resource)
  const loggerProvider = cds.env.requires.telemetry.logging ? logging(resource) : undefined

  // register instrumentations
  registerInstrumentations({
    tracerProvider,
    meterProvider,
    loggerProvider,
    instrumentations: _getInstrumentations()
  })
}

function setup_with_calm() {
  // setup tracing, metrics, and logging
  tracing()
  metrics()
  if (cds.env.requires.telemetry.logging) logging()
}

module.exports = hasCalmSupport() ? setup_with_calm : setup_standalone
