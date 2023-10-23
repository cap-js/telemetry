const cds = require('@sap/cds')

// Exporter must be registered before express app instantiation
if (cds.log('otel')._info && !process.env.OTEL_SDK_DISABLED) {
  require('./lib/initializer').registerProvider()
}
