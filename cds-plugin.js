const LOG = cds.log('cds')
const OTELInitializer = require('./plugin/OTEL-Initializer')

//Exporter must be registered before express app instantiation
if (LOG._info && !process.env.OTEL_SDK_DISABLED) OTELInitializer.registerProvider()
