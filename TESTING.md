# Testing

This document is the single, authoritative place for the hard-won, non-obvious knowledge behind the `@cap-js/telemetry` test suite. It is meant for contributors: read it before adding or debugging a test. Test files keep only the rationale that is local to a specific test; anything general or repeated lives here.

## Running the tests

```sh
npm test                      # vitest, sqlite in-memory (the default)
node_modules/.bin/vitest run  # same, without the --silent from the npm script
```

- **Runner:** [Vitest](https://vitest.dev). Config in [`vitest.config.mjs`](vitest.config.mjs).
- **Default database:** `@cap-js/sqlite`, in-memory. No external services are needed for the default run.
- **Test app:** a small bookshop under [`test/bookshop`](test/bookshop) — CDS model, services, and test-only wiring (exporters/reader, ignore hooks). Each test spins it up with `cds.test(__dirname + '/bookshop', ...)`.
- **CI matrix:** Node 22 & 24 × cds 9 & 10 (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The lint job additionally runs ESLint and `oxfmt --check`.

Lint / format locally:

```sh
npx eslint . --max-warnings=0   # npm run lint
npx oxfmt --check               # npm run format:check
```

## sqlite vs HANA

The suite runs on two databases, and the difference in DB **isolation model** drives most of the test infrastructure.

| | sqlite (default / PR CI) | HANA (separate workflow) |
| --- | --- | --- |
| DB per test file | **Own** in-memory DB — each file is fully isolated | **One shared** HDI container across *all* files |
| File parallelism | Full parallelism | **Serial** (`fileParallelism: false`) |
| Timeouts | 42s test / 30s hook | **10×** test timeout |
| Retries | 0 (deterministic) | `retry: 2` (self-heal unlucky timing) |
| Outbox bleed | Impossible (fresh DB) | Must be actively prevented (see below) |

Because HANA reuses one container for the whole run, a background queue/outbox worker from one file can still be draining when the next file starts and would dispatch leftover rows — adding foreign `cds.spawn - run task` root spans that break exact root-count assertions. The queue/outbox test files therefore:

- **clear the outbox** in `beforeEach` (before resetting the span buffer, so the `DELETE`'s own spans aren't captured), and
- **settle** in `afterAll`: clear, wait for the last worker iteration, clear again — every clear timeout-bounded via `clearOutbox` so a draining pool can't hang the hook.

All of this is a **no-op on sqlite** (fresh in-memory DB per file), gated on the HANA signal.

### How the HANA path is signalled

- The HANA job runs when `process.env.CI && process.env.HANA_DRIVER` are set. On that path `vitest.config.mjs` raises the timeout, disables file parallelism, enables retries, and excludes the multitenancy suites (see [Sanctioned skips](#sanctioned-skips)).
- It also sets **`process.env.TELEMETRY_TEST_HANA = '1'`** in the config module. Test files that must branch at **collection time** (before `cds.test()` applies its `--profile`) read this env var rather than `cds.env`: reading `cds.env` that early would freeze the env singleton before the profile is applied, so the tracer provider would be built with the wrong exporter and no spans would be captured.
- HANA runs from its **own workflow**, [`.github/workflows/hana.yml`](.github/workflows/hana.yml) — `workflow_dispatch` only, against a protected `hana` environment with a pre-provisioned HDI container. It is **not** part of the PR CI.

## Configuration via profiles (not env)

Test configuration lives in **[`test/bookshop/.cdsrc.json`](test/bookshop/.cdsrc.json)** as cds config profiles, selected per test file:

```js
cds.test(dir, '--profile', 'tracing-in-memory')          // one profile
cds.test(dir, '--profile', 'metrics-outbox, multitenancy') // profiles compose
```

| Profile | What it does |
| --- | --- |
| `[logging]` | Disables the tracing exporter (`false`) so no outbox-scan trace primer leaks into the console spy; wires a `ConsoleLogRecordExporter` + custom processor; sets `log.format: json` and `cls_custom_fields: ['foo']`. |
| `[metrics]` | Wires `MyInMemoryMetricReader`; short `exportIntervalMillis` (100). |
| `[metrics-outbox]` | Enables the queue (`_queue: true`) + in-memory reader; `exportIntervalMillis` 1000 (leaves the shared HANA worker DB headroom). |
| `[metrics-outbox-disabled]` | Queue metrics off (`_queue: false`) — asserts no `queue.*` datapoints are ever exported. |
| `[tracing-in-memory]` | Wires `MyInMemorySpanExporter` as the trace exporter. |
| `[sampler-ignore-authors]` | Adds `/odata/v4/admin/Authors` to the sampler's `ignoreIncomingPaths`. |
| `[native-fetch]` | `remote.native_fetch = true` — routes outbound remote calls through native fetch (undici instrumentation) instead of the Cloud SDK. |
| `[no-scheduling]` | `requires.scheduling: false` — disables cds 10's default periodic outbox reads (they cause spurious passport set/reset pairs). |
| `[persistent-outbox]` | file-based messaging with a persistent outbox. |
| `[inboxed]` | file-based messaging with `inboxed: true` (producer- **and** consumer-side queue workers). |
| `[without-outbox]` | file-based messaging with `outboxed: false` (writes to the file directly from the producer tx). |

> The `[multitenancy]` profile lives in the app's own `test/bookshop/package.json` (auth users + `multitenancy: true`), composed with the above where needed.

### Load-order gotcha (from #486)

`package.json` cds config is loaded **after** `.cdsrc.json` (last-writer-wins). So any base default that a profile must be able to override has to live in the **`.cdsrc.json` base**, not in `package.json` — otherwise `package.json` would clobber the profile. #486 moved the base `cds.log` / `messaging` defaults into `.cdsrc.json` for exactly this reason.

> **Do not** reintroduce `process.env.cds_*` string-JSON config. That fragile pattern (config via stringified JSON in env vars, order-sensitive against the `@sap/cds` require) was removed in #486. Use profiles.

## In-memory test infrastructure

Two exporter-shaped classes capture telemetry into module-level arrays that tests import directly — asserting on **structured spans/datapoints**, never scraping `console.dir` output:

- **[`test/bookshop/lib/MyInMemorySpanExporter.js`](test/bookshop/lib/MyInMemorySpanExporter.js)** — spans accumulate in `captured`; helpers `groupedByTrace()` / `rootSpans()` / `reset()`. Wired via the `tracing-in-memory` profile.
- **[`test/bookshop/lib/MyInMemoryMetricReader.js`](test/bookshop/lib/MyInMemoryMetricReader.js)** — metrics captured via the metrics profiles. It honors **DELTA temporality**, matching production (`lib/metrics/index.js` configures the real exporter with `AggregationTemporality.DELTA`), so the tests validate the real export shape. Under DELTA, counter datapoints report only the increment since the last collection, so the reader folds SUM increments into running totals while GAUGE datapoints keep their latest absolute value.

**KEY RULE:** neither module may `require('@sap/cds')` at module top. Doing so once broke span capture — the cds require has to happen inside the test file, *after* the profile is applied. Both modules stay dependency-light (only `@opentelemetry/*` primitives + node timers).

Cross-file correctness of the metric reader's process-level singletons relies on Vitest isolating each file in its own worker (`pool: 'forks'`, `isolate: true`); two files sharing the module in one process would bleed counter totals together.

## Shared test helpers — `test/utils.js`

Centralized in [`test/utils.js`](test/utils.js) (added in #488) so the ~10 tracing/metrics suites stop copy-pasting them. See the doc comments at each definition for full detail:

- **`flushSpans()`** — force-flush the tracer provider's span processor so buffered spans reach `captured`.
- **`eventually(fn, { flush, timeout, interval })`** — state-based wait: repeatedly flush + re-run the assertion until it holds or times out. Replaces fixed `wait(...)` sleeps that flake on HANA (background/spawned work flushes after any reasonable fixed window). `flush` defaults to `flushSpans`.
- **`makeExpectEventually(flush, { timeout, interval })`** — builds an `expectEventually(assertion)` bound to a specific flush target + poll defaults (metric suites pass the reader's `forceFlush`).
- **`clearOutbox(timeout)`** — best-effort, timeout-bounded outbox `DELETE` that can never hang the surrounding hook (a draining HANA pool could otherwise block indefinitely).
- **`asExternalClient(fn)`** — runs a client request under `suppressTracing`. The in-process test client would otherwise create an outgoing **CLIENT** span for every request (an artificial extra root that also overwrites any manually-set `traceparent`). Real callers are separate, un-instrumented processes; this models that so the incoming SERVER span is created normally and stays the trace root.
- **`isOutboxScanTrace(g)` / `meaningful(groups)`** — filter out the queue scheduler's pure outbox-scan bookkeeping traces (a `db - tx` root touching only `cds.outbox.Messages`) so exact root-count assertions stay stable on the shared HANA container.

**The flush + poll pattern:** instead of `await wait(500)` then asserting, wrap assertions in `eventually`/`expectEventually` — it flushes, checks, and returns the instant the state holds (fast on sqlite, resilient to HANA's variable worker latency).

## HTTP instrumentation (from #475)

HTTP instrumentation is enabled in the test app. Consequences the tests rely on:

- **Incoming** requests produce a **SERVER** span that becomes each request trace's **root**; existing `<service> - tx` spans reparent under it (reparenting). The SERVER span also adopts the W3C trace context from an incoming `traceparent` header.
- **Outgoing** requests produce **CLIENT** spans.

Because the test HTTP client runs in-process, its outgoing requests would themselves create CLIENT-span roots and pollute the trace. Tests therefore wrap client requests in **`asExternalClient`** (see above) to model an external, un-instrumented caller.

## Sanctioned skips

Only **two** skips are allowed (per #477). Any *new* skip must be justified against this bar; everything else that is skipped is tracked debt.

1. **SAP Passport** — [`test/passport.test.js`](test/passport.test.js) skips on **sqlite** (`db.kind === 'sqlite'`). SAP Passport is a HANA session-context feature with no sqlite equivalent; it runs on HANA.
2. **Multitenancy on HANA** — `tracing-mt.test.js` and `metrics-outbox-multitenant.test.js` are **excluded from the HANA job** (in `vitest.config.mjs`). MTX tenant subscription needs a bound BTP Service Manager to provision per-tenant HDI containers, which the single pre-provisioned HDI container in CI lacks. They run fully on sqlite (in-memory tenants).

This is the inverse pairing: passport is sqlite-skip / HANA-run; multitenancy is HANA-skip / sqlite-run.

Other skips are **debt tracked in #477**, not sanctioned exceptions:

- **§1 — queue-worker tracing on sqlite:** `tracing-scheduled`, `tracing-outboxed-batch`, `tracing-messaging-inboxed`, `tracing-messaging-persistent-outbox` skip their worker-span cases on sqlite. Published `@sap/cds` uses a raw `setTimeout` bypass (not `cds.spawn`) for the sqlite queue worker to avoid a single-writer deadlock, so the `cds.spawn - run task` root span never appears. Gated on a cds queue-spawn fix landing; remove with a follow-up.
- **§3 — unimplemented stubs:** placeholder `test.skip` cases in `tracing.test.js` and `tracing-mt.test.js` (individual handlers, remote, `$batch`, `srv.emit`, `cds.spawn` under multitenancy) — real coverage gaps to be written.

## Known caveats & gotchas

- **`startup > NO_TELEMETRY=true` local artifact.** [`test/startup.test.js`](test/startup.test.js) shells out to `cds serve` with env overrides. In some local shells the `NO_TELEMETRY=true` case can fail due to inherited environment; it passes in CI and in a clean environment. This is a pre-existing local-env artifact, not a product bug.
- **Internal-registry lockfile trap for `@sap/*` installs.** Installing `@sap/*` packages against SAP's internal registry can rewrite `package-lock.json` to internal URLs. Always install against the public npm registry and verify the lockfile is clean before committing:

  ```sh
  grep -c int.repositories.cloud.sap package-lock.json   # must be 0
  ```
