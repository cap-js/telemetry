import { defineConfig } from 'vitest/config'

// Default: 42s timeout, run every *.test.js file.
let testTimeout = 42000
let include = ['test/**/*.test.js']

// HANA CI runs only a small subset with a 10x timeout (ported from the old
// jest.config.js). The `cds_requires_telemetry_tracing` env has to be set here,
// before any test file requires @sap/cds, so keep it in the config module.
if (process.env.CI && process.env.HANA_DRIVER) {
  testTimeout *= 10
  include = ['test/**/tracing-attributes.test.js', 'test/**/passport.test.js']

  if (process.env.HANA_PROM)
    process.env.cds_requires_telemetry_tracing = JSON.stringify({ _hana_prom: process.env.HANA_PROM === 'true' })
}

export default defineConfig({
  test: {
    // globals:true keeps describe/test/beforeEach/... available without importing
    // them in every test file (smallest diff to the existing jest suite).
    globals: true,
    include,
    testTimeout,
    // The OTLP exporters (and CAP's telemetry SDK) can leave open handles/timers
    // alive. Run each test file in its own forked child process so that, once a
    // file finishes, its process is torn down and the handles die with it. This
    // is what makes the suite EXIT CLEANLY where jest needed --forceExit.
    // (In Vitest 4 the former poolOptions.forks.* are top-level options.)
    pool: 'forks',
    // fresh child per file: matches jest's per-file isolation and preserves the
    // top-of-module process.env mutations some test files rely on.
    isolate: true,
    // don't hang the run waiting on lingering handles at teardown.
    teardownTimeout: 5000
  }
})
