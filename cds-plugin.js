let _startup = true

const cds = require('@sap/cds')
if (!(cds.cli?.command in { '': 1, serve: 1, run: 1 })) _startup = false

// cds add XXX currently also has cli.command === ''
const i = process.argv.indexOf('add')
if (i > 1 && process.argv[i - 1].match(/cds(\.js)?$/)) _startup = false

if (!!process.env.NO_TELEMETRY && process.env.NO_TELEMETRY !== 'false') _startup = false

if (_startup) require('./lib')()
