const config = {
  testTimeout: 42000,
  testMatch: ['**/*.test.js']
}

if (process.env.HANA_DRIVER) {
  config.testTimeout *= 10
  // config.testMatch = ['**/tracing-attributes.test.js']
}

module.exports = config
