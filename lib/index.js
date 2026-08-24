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
const { getDiagLogLevel, getResource, hasDependency, initializeZTI, _require } = require('./utils')

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

/**
 * Check if ZTI (Zero Trust Identity) is enabled and has configuration
 * ZTI requires waiting for SVID files which can take ~10 seconds
 */
function _needsZTIWait() {
  // ZTI is disabled via env var
  if (process.env.CDS_REQUIRES_TELEMETRY_USE_ZTI === 'false') return false

  // Check if CaaS telemetry kind is configured
  const kind = cds.env.requires.telemetry?.kind
  if (!kind?.match(/to-caas$/)) return false

  // Check for ZTI binding in VCAP_SERVICES
  const vcapServices = process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES)
  if (!vcapServices) return false

  // Look for zero-trust-identity binding (check both tags and label)
  for (const [key, services] of Object.entries(vcapServices)) {
    // Check if the service key itself indicates ZTI
    if (key === 'zero-trust-identity') return true
    for (const svc of services) {
      if (svc.tags?.includes('zero-trust-identity')) return true
      if (svc.label === 'zero-trust-identity') return true
    }
  }

  return false
}

async function setup_standalone() {
  // set logger and propagate log level
  diag.setLogger(cds.log('telemetry'), getDiagLogLevel())

  // create resource
  const resource = getResource()

  // Set up CDS method wrapping
  require('./tracing/cds')()
  require('./tracing/cloud_sdk')()

  // Check if ZTI is needed (async wait for SVID files)
  const needsZTI = _needsZTIWait()

  if (needsZTI) {
    // ZTI FLOW: Register TracerProvider early, add exporters after SVID ready
    // This ensures HTTP instrumentation gets a real tracer instead of NoopTracer
    // while waiting for SVID certificates

    // STEP 1: Create TracerProvider EARLY (before ZTI wait) - no exporter yet
    const tracerProvider = tracing.createTracerProvider(resource)

    // STEP 2: Register instrumentations IMMEDIATELY (so HTTP gets real tracer)
    // Note: metrics/logging exporters will be created after ZTI is ready
    registerInstrumentations({
      tracerProvider,
      meterProvider: undefined, // Will be created after ZTI
      loggerProvider: undefined,
      instrumentations: _getInstrumentations()
    })

    // STEP 3: Wait for ZTI SVID files
    try {
      await initializeZTI()
    } catch (err) {
      LOG._error && LOG.error('Failed to initialize ZTI for CaaS mTLS:', err)
    }

    // STEP 4: Now create metrics and logging (they need mTLS creds)
    const meterProvider = metrics(resource)
    const loggerProvider = cds.env.requires.telemetry.logging ? logging(resource) : undefined

    // STEP 5: Add trace exporter now that credentials are available
    tracing.addTracingExporter(tracerProvider)
  } else {
    // STANDARD FLOW: Synchronous setup (original behavior)
    // No ZTI wait needed, so we can create provider with exporter immediately

    // Initialize ZTI if configured (will be no-op if not needed)
    try {
      await initializeZTI()
    } catch (err) {
      LOG._error && LOG.error('Failed to initialize ZTI for CaaS mTLS:', err)
    }

    // Setup tracing, metrics, and logging
    const tracerProvider = tracing(resource)
    const meterProvider = metrics(resource)
    const loggerProvider = cds.env.requires.telemetry.logging ? logging(resource) : undefined

    // Register instrumentations
    registerInstrumentations({
      tracerProvider,
      meterProvider,
      loggerProvider,
      instrumentations: _getInstrumentations()
    })
  }
}

async function setup_with_calm() {
  // Initialize ZTI if configured - must complete before creating exporters
  try {
    await initializeZTI()
  } catch (err) {
    LOG._error && LOG.error('Failed to initialize ZTI for CaaS mTLS:', err)
  }

  // setup tracing, metrics, and logging
  tracing()
  metrics()
  if (cds.env.requires.telemetry.logging) logging()
}

module.exports = hasDependency('@sap/xotel-agent-ext-js') ? setup_with_calm : setup_standalone
