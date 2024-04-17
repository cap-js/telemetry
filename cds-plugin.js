if (!process.env.NO_TELEMETRY || process.env.NO_TELEMETRY === 'false') require('./lib')()

const cds = require('@sap/cds')
cds.add?.register('telemetry', require('./lib/add'))
