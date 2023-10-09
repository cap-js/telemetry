const cds = require('@sap/cds')

// Exporter must be registered before express app instantiation
// REVISIT: why check log level (of default logger)?
if (cds.log('cds')._info && !process.env.OTEL_SDK_DISABLED) {
  require('./plugin/OTEL-Initializer').registerProvider()
}
