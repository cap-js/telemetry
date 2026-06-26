;(() => {
  const cds = require('@sap/cds')
  if (!(cds.cli?.command in { '': 1, serve: 1, run: 1 })) return

  // REVISIT: workaround for cds.cli.command bug
  if (process.argv.includes('build')) return

  // cds add XXX currently also has cli.command === ''
  const i = process.argv.indexOf('add')
  if (i > 1 && process.argv[i - 1].match(/cds(\.js)?$/)) return

  if (!!process.env.NO_TELEMETRY && process.env.NO_TELEMETRY !== 'false') return

  require('./lib')()
})()
