const childProcess = require('child_process')

const startup = cmd => {
  return new Promise(resolve => {
    const p = childProcess.exec(cmd, {
      env: Object.assign({}, process.env, { CDS_REQUIRES_TELEMETRY_KIND: 'to-cloud-logging' }),
      cwd: __dirname + '/bookshop'
    })
    p.on('exit', () => {
      resolve(!p.exitCode ? false : true)
    })
    p.stdout.on('data', data => {
      if (data.match(/server listening on/)) p.kill()
    })
  })
}

describe('plugin started', () => {
  afterAll(() => {
    require('fs').unlinkSync(__dirname + '/bookshop/mta.yaml')
    require('fs').rmdirSync(__dirname + '/bookshop/gen', { recursive: true })
  })

  test('not for NO_TELEMETRY=true', async () => {
    const started = await startup('NO_TELEMETRY=true cds serve')
    expect(started).toBe(false)
  })

  test('for NO_TELEMETRY=false', async () => {
    const started = await startup('NO_TELEMETRY=false cds serve')
    expect(started).toBe(true)
  })

  test('for cds serve', async () => {
    const started = await startup('cds serve')
    expect(started).toBe(true)
  })

  test('for cds run', async () => {
    const started = await startup('cds run')
    expect(started).toBe(true)
  })

  test('not for cds build', async () => {
    const started = await startup('cds build --production')
    expect(started).toBe(false)
  })

  test('not for cds add', async () => {
    const started = await startup('cds add mta')
    expect(started).toBe(false)
  })
})
