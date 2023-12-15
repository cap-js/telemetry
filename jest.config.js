// FIXME: should not be necessary
process.env.CDS_ENV = 'better-sqlite'

const config = {
  testTimeout: 42000,
  testMatch: ['**/*.test.js']
}

module.exports = config
