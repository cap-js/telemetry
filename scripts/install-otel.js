const { spawnSync } = require('node:child_process')
const pkg = require('../package.json')

const major = process.argv[2]
if (!['2', '3'].includes(major)) throw new Error('Usage: node scripts/install-otel.js <2|3>')
const cdsMajor = process.argv[3]
if (cdsMajor && !['9', '10'].includes(cdsMajor)) throw new Error('CDS major must be 9 or 10')

const versions = {
  '@opentelemetry/api': major === '2' ? '~1.9.0' : '~1.10.0',
  '@opentelemetry/instrumentation-host-metrics': major === '2' ? '^0.6.0' : '^0.7.0',
  '@opentelemetry/instrumentation-runtime-node': major === '2' ? '^0.36.0' : '^0.37.0',
  '@opentelemetry/instrumentation-undici': major === '2' ? '^0.33' : '^0.34'
}
const stable = ['context-async-hooks', 'core', 'resources', 'sdk-metrics', 'sdk-trace', 'semantic-conventions']
const packages = Object.keys(pkg.devDependencies)
  .filter(name => name.startsWith('@opentelemetry/'))
  .map(name => {
    const shortName = name.slice('@opentelemetry/'.length)
    let version = versions[name]
    if (!version) {
      if (shortName === 'semantic-conventions') version = pkg.peerDependencies[name]
      else if (stable.includes(shortName)) version = major === '3' ? '^3' : shortName === 'sdk-trace' ? '^2.9' : '^2.8'
      else version = major === '3' ? '^0.300' : '^0.223'
    }
    return `${name}@${version}`
  })
if (cdsMajor === '9') packages.push('@sap/cds@9', '@cap-js/sqlite@2', '@sap/cds-mtxs@3')

// Override the complete SDK family together without rewriting the SDK-2 lockfile.
const result = spawnSync(
  'npm',
  ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', ...packages],
  {
    cwd: require('node:path').join(__dirname, '..'),
    stdio: 'inherit'
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
