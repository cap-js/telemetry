const cds = require('@sap/cds')
if (!cds.cli && (!process.env.NO_TELEMETRY || process.env.NO_TELEMETRY === 'false')) require('./lib')()

cds.add?.register('telemetry', require('./lib/add'))
