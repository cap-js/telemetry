const config = {
  testTimeout: 42000,
  testMatch: ['**/*.test.js']
}

if (process.env.CI && process.env.HANA_DRIVER) {
  config.testTimeout *= 10
  // config.testMatch = ['**/tracing-attributes.test.js', '**/passport.test.js']
  config.testMatch = ['**/passport.test.js']

  if (process.env.HANA_PROM)
    process.env.cds_requires_telemetry_tracing = JSON.stringify({ _hana_prom: process.env.HANA_PROM === 'true' })
}

module.exports = config
