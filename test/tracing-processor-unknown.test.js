// Tests that an unknown processor kind causes the tracing factory to throw.
//
// Boot the bookshop server so cds.env is fully configured with the tracing-in-memory
// profile, then call the real tracing factory (lib/tracing/index.js) with a bogus
// processor kind. The factory throws before creating the tracerProvider or calling
// .register(), so passing {} as the resource arg is safe and causes no double-register.
// require('./cds')() and require('./cloud_sdk')() run first, but both use the wrap()
// utility which guards against double-wrapping via the __wrapped flag — idempotent.
const cds = require('@sap/cds')
const { expect } = cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

const tracing = require('../lib/tracing')

describe('span processor selection — unknown kind', () => {
  test('unknown processor kind throws with a descriptive error', () => {
    const cfg = cds.env.requires.telemetry.tracing
    const orig = cfg.processor
    try {
      cfg.processor = { kind: 'NotARealProcessor' }
      expect(() => tracing({})).toThrow(/Unknown span processor NotARealProcessor/)
    } finally {
      cfg.processor = orig
    }
  })
})
