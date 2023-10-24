// Exporter must be registered before express app instantiation
if (!process.env.OTEL_SDK_DISABLED) {
  require('./lib/initializer').registerProvider()
}
