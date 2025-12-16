;(() => {
  const cds = require('@sap/cds')
  if (!(cds.cli?.command in { '': 1, serve: 1, run: 1 })) return

  // REVISIT: workaround for cds.cli.command bug
  if (process.argv.includes('build')) return

  // cds add XXX currently also has cli.command === ''
  const i = process.argv.indexOf('add')
  if (i > 1 && process.argv[i - 1].match(/cds(\.js)?$/)) return

  if (!!process.env.NO_TELEMETRY && process.env.NO_TELEMETRY !== 'false') return

  const _version_of = module => {
    let pkg
    try {
      pkg = require(`${module}/package.json`)
    } catch {
      try {
        const path = require.resolve(module).split(module)[0] + module + '/package.json'
        pkg = JSON.parse(require('fs').readFileSync(path, 'utf-8'))
      } catch {
        // ignore
      }
    }
    if (!pkg) {
      cds.log('telemetry').warn(`Unable to determine version of ${module}`)
      return
    }
    return pkg.version
  }

  // check versions of @opentelemetry dependencies
  const { dependencies } = require(require('path').join(cds.root, 'package'))
  let violations = []
  for (const each in dependencies) {
    if (!each.match(/^@opentelemetry\//)) continue
    const version = _version_of(each)
    if (!version) continue
    const [major, minor] = version.split('.')
    if (major >= 2 || minor >= 200) violations.push(`${each}@${version}`)
  }
  if (violations.length) {
    const msg =
      '@cap-js/telemetry does not yet support OpenTelemetry SDK 2.0 (^2 and ^0.200):' +
      `\n  - ${violations.join('\n  - ')}\n`
    throw new Error(msg)
  }

  require('./lib')()
})()
