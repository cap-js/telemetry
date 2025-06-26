const config = {
  testTimeout: 42000,
  testMatch: ['**/*.test.js']
}

if (process.env.HANA_DRIVER) {
  config.testTimeout *= 10
  // config.testMatch = ['**/tracing-attributes.test.js']

  const credentials = JSON.parse(process.env.CAPJS_TELEMETRY_TEST_BOOKSHOP_DB_CREDENTIALS)
  process.env.cds_requires_db = JSON.stringify({ kind: 'hana', credentials })
}

module.exports = config
