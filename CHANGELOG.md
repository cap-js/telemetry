# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).
The format is based on [Keep a Changelog](http://keepachangelog.com/).

## Version 1.3.1 - 2025-04-29

### Fixed

- Version check in TypeScript projects

## Version 1.3.0 - 2025-04-25

### Added

- Skip instrumentation of HANA driver, if it does it itself
- `telemetry-to-otlp`: Automatically switch to `gRPC` (from default `http/protobuf`) when exporting to an endpoint with port `4317`
- Version check for `@opentelemetry` dependencies (OpenTelemetry SDK 2.0 is not yet supported)

### Changed

- By default, `@cap-js/hana`'s promisification of the driver API is wrapped
  + Disable via config `cds.requires.telemetry.tracing._hana_prom = false`

### Fixed

- `NonRecordingSpan`s do not have `attributes`

### Removed

- Inofficial instrumentation of legacy OData server

## Version 1.2.4 - 2025-04-09

### Fixed

- User-provided instances of SAP Cloud Logging should have either tag `cloud-logging` or `Cloud Logging`

## Version 1.2.3 - 2025-03-10

### Fixed

- Database span attributes
- Don't crash in case there are errors while determining the attributes for the current span

## Version 1.2.2 - 2025-03-03

### Fixed

- Handle SAP Passport inside `tracer.startActiveSpan()`

## Version 1.2.1 - 2025-02-25

### Fixed

- Don't crash in case property `instrumentationLibrary` of parent span is undefined

## Version 1.2.0 - 2025-02-14

### Added

- Improved support for tracing messaging services and `cds.spawn`
- Support for adding custom spans to trace hierarchy via `tracer.startActiveSpan()`
- Trace attribute `db.client.response.returned_rows` for queries via `cds.ql`
- Option to pass custom config to span processor via `cds.requires.telemetry.tracing.processor.config`
- Support for loading instrumentation hooks via path relative to `cds.root`.
  - The respective module must export either a function or, for bundling purposes, an object with a function named after the respective hook.
  - Example based on `@opentelemetry/instrumentation-http`:
    ```json
    "instrumentations": {
      "http": {
        "config": {
          "ignoreIncomingRequestHook": "./lib/MyIgnoreIncomingRequestHook.js"
        }
      }
    }
    ```
- Support for ignoring incoming requests that match a certain base path via `cds.requires.telemetry.tracing.sampler.ignoreIncomingPaths = []` (beta)
- Experimental!: Trace HANA interaction via `@cap-js/hana`'s promisification of the driver API for increased accuracy
  - Enable via config `cds.requires.telemetry.tracing._hana_prom`
  - Requires `@cap-js/hana^1.7.0`
- Experimental!: Intercept and export application logs (cf. `cds.log()`) via OpenTelemetry
  - Enable by adding section `logging` to `cds.requires.telemetry` as follows (using `grpc` as an example):
    ```json
    "logging": {
      "exporter": {
        "module": "@opentelemetry/exporter-logs-otlp-grpc",
        "class": "OTLPLogExporter"
      }
    }
    ```
  - Requires additional dependencies `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, and the configured exporter module (`cds.requires.telemetry.logging.module`)

### Changed

- Default config `ignoreIncomingPaths: ['/health']` moved from `cds.requires.telemetry.instrumentations.http.config` to `cds.requires.telemetry.tracing.sampler`

### Fixed

- User-provided instances of SAP Cloud Logging should have a tag `cloud-logging` (not a name matching `cloud-logging`)

### Removed

- Internal `cds._telemetry`

## Version 1.1.2 - 2024-12-10

### Fixed

- ConsoleSpanExporter: `cds.context` may be undefined in local scripting scenarios

## Version 1.1.1 - 2024-11-28

### Fixed

- Use attribute `url.path` (with fallback to deprecated `http.target`) for sampling decision

## Version 1.1.0 - 2024-11-27

### Added

- Predefined kind `telemetry-to-otlp` that creates exporters based on OTLP exporter configuration via environment variables
- If `@opentelemetry/instrumentation-runtime-node` is in the project's dependencies but not in `cds.requires.telemetry.instrumentations`, it is registered automatically
  - Disable via `cds.requires.telemetry.instrumentations.instrumentation-runtime-node = false`
- Experimental!: Propagate W3C trace context to SAP HANA via session context `SAP_PASSPORT`
  - Enable via environment variable `SAP_PASSPORT`

### Changed

- Base config moved to new `cds.requires.kinds.telemetry` for improved config merging

### Fixed

- Built-in `ConsoleMetricExporter` uses correct attribute name `process.cpu.state` while exporting host metrics
- Exporting traces to the console in the presence of a traceparent header

## Version 1.0.1 - 2024-08-10

### Fixed

- Explicitly pass own providers when registering instrumentations (the global providers may be influenced by, for example, Dynatrace OneAgent)

## Version 1.0.0 - 2024-08-08

### Added

- Support for tracing native db statements (i.e., `cds.run('SELECT * FROM DUMMY')`)
- Support for SAP Cloud Logging credentials via user-provided service
- Support for adding `@opentelemetry/instrumentation-runtime-node`
  - `npm add @opentelemetry/instrumentation-runtime-node`
  - To `cds.requires.telemetry.instrumentations`, add:
    ```json
    "instrumentation-runtime-node": {
      "class": "RuntimeNodeInstrumentation",
      "module": "@opentelemetry/instrumentation-runtime-node"
    }
    ```

### Changed

- Instrumentations are registered after tracing and metrics are set up
- `telemetry-to-dynatrace`: Regardless of whether Dynatrace OneAgent is present or not, if dependency `@opentelemetry/exporter-trace-otlp-proto` is present, `@cap-js/telemetry` will export the traces via OpenTelemetry.

### Fixed

- Tracing of db statements without active span

## Version 0.2.3 - 2024-06-17

### Fixed

- Only startup plugin if invoked for runtime (e.g., via cli `cds serve`)

## Version 0.2.2 - 2024-06-03

### Fixed

- Detect build job started via `@sap/cds-dk/bin/cds.js`

## Version 0.2.1 - 2024-05-23

### Fixed

- Avoid credentials validation during `cds build`

## Version 0.2.0 - 2024-05-17

### Added

- Support for local modules (e.g., exporters) via `[...].module = '<path relative to cds.root>'`
- Disable pool metrics via `cds.requires.telemetry.metrics._db_pool = false` (beta)

### Fixed

- Get credentials from `cds.env`
- Validate existence of credentials only for configured kind
- HTTP attributes only for root spans (reduces trace payload size)

## Version 0.1.0 - 2024-03-22

### Added

- Support for own, high resolution timestamps
  - Enable via `cds.requires.telemetry.tracing.hrtime = true`
  - Enabled by default in development profile

## Version 0.0.5 - 2024-03-11

### Added

- Register span processor also if tracer provider is initialized by a different module
- Support for so-called _Pull Metric Exporter_ (e.g., `@opentelemetry/exporter-prometheus`)
- Tenant-dependent DB attributes

### Changed

- By default, all `system.*` metrics collected by `@opentelemetry/host-metrics` are ignored
  - Disable change via environment variable `HOST_METRICS_RETAIN_SYSTEM=true`
- Metric exporter's property `temporalityPreference` always gets defaulted to `DELTA`
  - Was previously only done for kind `telemetry-to-dynatrace`
  - Set custom value via `cds.requires.telemetry.metrics.exporter.config.temporalityPreference`

### Fixed

- Identification of first-level spans in built-in `ConsoleSpanExporter`

## Version 0.0.4 - 2024-02-09

### Added

- Re-use `TracerProvider` and `MeterProvider` that were initialized by a different module (OpenTelemetry only allows one-time initialization)

### Fixed

- `NonRecordingSpan`s are handled correctly

## Version 0.0.3 - 2024-01-30

### Added

- Support for exporting traces to Dynatrace via OpenTelemetry exporter (instead of Dynatrace OneAgent)
- Support for Dynatrace credentials via user-provided service
- `@opentelemetry/host-metrics` is automatically fired up, if it is in the project's dependencies

## Version 0.0.2 - 2024-01-15

### Added

- Predefined kind for SAP Cloud Logging (`telemetry-to-cloud-logging`)
- Built-in `ConsoleMetricExporter` prints DB pool and other metrics separately

## Version 0.0.1 - 2024-01-04

### Added

- Initial release
