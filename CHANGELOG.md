# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).
The format is based on [Keep a Changelog](http://keepachangelog.com/).

## Version 0.0.5 - tbd

### Added

- Register span processor also if tracer provider is initialized by a different module

### Changed

- By default, all `system.*` metrics collected by `@opentelemetry/host-metrics` are ignored
  + Disable change via environment variable `HOST_METRICS_RETAIN_SYSTEM=true`

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
