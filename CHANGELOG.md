# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).
The format is based on [Keep a Changelog](http://keepachangelog.com/).

## Version 1.0.0 - tbd

### Added

- Support for tracing native db statements (i.e., `cds.run('SELECT * FROM DUMMY')`)
- Support for SAP Cloud Logging credentials via user-provided service

### Changed

### Fixed

### Removed

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
- Disable pool metrics via `cds.env.requires.telemetry.metrics._db_pool = false` (beta)

### Fixed

- Get credentials from `cds.env`
- Validate existence of credentials only for configured kind
- HTTP attributes only for root spans (reduces trace payload size)

## Version 0.1.0 - 2024-03-22

### Added

- Support for own, high resolution timestamps
  + Enable via `cds.env.requires.telemetry.tracing.hrtime = true`
  + Enabled by default in development profile

## Version 0.0.5 - 2024-03-11

### Added

- Register span processor also if tracer provider is initialized by a different module
- Support for so-called _Pull Metric Exporter_ (e.g., `@opentelemetry/exporter-prometheus`)
- Tenant-dependent DB attributes

### Changed

- By default, all `system.*` metrics collected by `@opentelemetry/host-metrics` are ignored
  + Disable change via environment variable `HOST_METRICS_RETAIN_SYSTEM=true`
- Metric exporter's property `temporalityPreference` always gets defaulted to `DELTA`
  + Was previously only done for kind `telemetry-to-dynatrace`
  + Set custom value via `cds.env.requires.telemetry.metrics.exporter.config.temporalityPreference`

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
