let _startup = true

const cds = require('@sap/cds')
if (!(cds.cli?.command in { '': 1, serve: 1, run: 1 })) _startup = false

cds.add?.register('telemetry', require('./lib/add/cloud-logging'))
cds.add?.register('cloud-logging', require('./lib/add/cloud-logging'))
cds.add?.register('dynatrace', require('./lib/add/dynatrace'))

if (!!process.env.NO_TELEMETRY && process.env.NO_TELEMETRY !== 'false') _startup = false

if (_startup) require('./lib')()
