import { defineConfig, configDefaults } from 'vitest/config'

// Default: 42s timeout, run every *.test.js file.
let testTimeout = 42000
let hookTimeout = 30000
let include = ['test/**/*.test.js']
let exclude = configDefaults.exclude

// HANA CI runs the FULL suite (`test/**/*.test.js`, the default `include`) with a
// 10x test timeout since HANA is slower than sqlite. The `cds_requires_telemetry_tracing`
// env has to be set here, before any test file requires @sap/cds, so keep it in the
// config module.
const HANA = process.env.CI && process.env.HANA_DRIVER
if (HANA) {
  testTimeout *= 10

  // Multitenancy needs a bound BTP Service Manager (MTX) to provision per-tenant HDI
  // containers. The HANA CI runs against a single pre-provisioned HDI container with no
  // Service Manager, so these two suites can't run there — exclude them from the HANA job
  // entirely (they still run on sqlite with in-memory tenants).
  exclude = [...configDefaults.exclude, '**/tracing-mt.test.js', '**/metrics-outbox-multitenant.test.js']

  // Signal "running on HANA" to test files that must branch at COLLECTION time (before
  // cds.test() applies its --profile), e.g. the queue/outbox files that skip the sqlite-only
  // cds.spawn cases. Reading cds.env at collection time would freeze the env singleton before
  // the profile is applied, so files read this env var instead.
  process.env.TELEMETRY_TEST_HANA = '1'

  if (process.env.HANA_PROM)
    process.env.cds_requires_telemetry_tracing = JSON.stringify({ _hana_prom: process.env.HANA_PROM === 'true' })
}

export default defineConfig({
  test: {
    // globals:true keeps describe/test/beforeEach/... available without importing
    // them in every test file (smallest diff to the existing jest suite).
    globals: true,
    include,
    exclude,
    testTimeout,
    hookTimeout,
    // A couple of queue/outbox tests are timing-sensitive against the SHARED remote HANA Cloud
    // HDI container (non-deterministic queue-worker latency); the afterAll settle reduces but
    // can't fully remove the flakiness. Retry on HANA only so an unlucky timing miss self-heals;
    // sqlite (per-file in-memory DB) is deterministic and gets no retries.
    retry: HANA ? 2 : 0,
    // The OTLP exporters (and CAP's telemetry SDK) can leave open handles/timers
    // alive. Run each test file in its own forked child process so that, once a
    // file finishes, its process is torn down and the handles die with it. This
    // is what makes the suite EXIT CLEANLY where jest needed --forceExit.
    // (In Vitest 4 the former poolOptions.forks.* are top-level options.)
    pool: 'forks',
    // fresh child per file: matches jest's per-file isolation and preserves the
    // top-of-module process.env mutations some test files rely on.
    isolate: true,
    // On HANA every test file shares ONE HDI container (unlike sqlite's per-file
    // in-memory DB), so files must not run concurrently: parallel workers collide on
    // fixture INSERTs and on the shared cds.outbox.Messages table. Run files serially
    // on HANA; the queue/outbox test files also clear the outbox in a beforeAll so a
    // prior file's leftover rows can't bleed in. (sqlite keeps full parallelism.)
    fileParallelism: !HANA,
    // don't hang the run waiting on lingering handles at teardown.
    teardownTimeout: 5000
  }
})
