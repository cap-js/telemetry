const config = {
  testTimeout: 42000,
  testMatch: ['**/*.test.js']
}

if (process.env.CI && process.env.HANA_DRIVER) {
  config.testTimeout *= 10
  config.testMatch = ['**/tracing-attributes.test.js', '**/passport.test.js']

  if (process.env.HANA_PROM)
    process.env.cds_requires_telemetry_tracing = JSON.stringify({ _hana_prom: process.env.HANA_PROM === 'true' })
}

// use node-native sqlite driver to avoid postinstall scripts
if (!process.env.HANA_DRIVER) process.env.CDS_REQUIRES_DB_DRIVER = 'node'

module.exports = config
