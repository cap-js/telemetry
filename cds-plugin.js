if (!process.env.NO_TELEMETRY) require('./lib')()

/*
 * Export exporters
 */
module.exports = require('./lib/exporter')
