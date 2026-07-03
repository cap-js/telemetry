module.exports = (CASE, CHECK) => {
  const cds = require('@sap/cds')
  const { expect, POST } = cds.test(__dirname + '/bookshop', '--profile', `${CASE},tracing-in-memory`)
  const { reset, rootSpans, groupedByTrace, captured } = require('./bookshop/lib/MyInMemorySpanExporter')

  const wait = require('node:timers/promises').setTimeout

  const admin = { auth: { username: 'alice' } }

  const rm = () => {
    try {
      require('fs').rmSync(require('path').join(__dirname, CASE))
    } catch {
      // ignore
    }
  }

  beforeAll(async () => {
    rm()
    await wait(100)
  })

  afterAll(async () => {
    // Wait long enough for any background queue-worker / scheduling-service timers to
    // fire one last time before jest tears down the env. Without this, those timers can
    // fire after teardown and crash with "cds.error.isSystemError is not a function"
    // (cds module is reloaded between tests, but the timer references the old instance).
    await wait(2000)
    rm()
  })

  beforeEach(() => {
    reset()
  })

  test('emit is traced', async () => {
    await POST('/odata/v4/admin/test_emit', {}, admin)
    await wait(2500)
    // CHECK is called with span-level data: { expect, rootSpans, groupedByTrace, captured, cds }
    CHECK({ expect, rootSpans: rootSpans(), groupedByTrace: groupedByTrace(), captured: [...captured], cds })
  })
}
