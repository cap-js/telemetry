# Welcome to @cap-js/telemetry

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/telemetry)](https://api.reuse.software/info/github.com/cap-js/telemetry)



## About this project

`@cap-js/telemetry` is a CDS plugin providing observability features, including [automatic OpenTelemetry instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/automatic).

Documentation can be found at [cap.cloud.sap](https://cap.cloud.sap/docs) and [opentelemetry.io](https://opentelemetry.io/docs).



## Table of Contents

- [About this project](#about-this-project)
- [Requirements](#requirements)
- [Setup](#setup)
- [Predefined Kinds](#predefined-kinds)
  - [`telemetry-to-console`](#telemetry-to-console)
  - [`telemetry-to-dynatrace`](#telemetry-to-dynatrace)
  - [`telemetry-to-cloud-logging`](#telemetry-to-cloud-logging)
  - [`telemetry-to-jaeger`](#telemetry-to-jaeger)
- [Detailed Configuration Options](#detailed-configuration-options)
  - [Instrumentations](#instrumentations)
  - [Sampler](#sampler)
  - [Propagators](#propagators)
  - [Exporters](#exporters)
  - [Environment variables](#environment-variables)
- [Support, Feedback, Contributing](#support-feedback-contributing)
- [Code of Conduct](#code-of-conduct)
- [Licensing](#licensing)



## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.



## Setup

Simply add `@cap-js/telemetry` to your dependencies via `npm add @cap-js/telemetry` and you will find telemetry output written to the console.
See [Predefined Kinds](#predefined-kinds) for additional dependencies you need to bring yourself when exporting to Dynatrace, Jaeger, etc.

The plugin can be disabled by setting environment variable `NO_TELEMETRY` to something truthy.

Database tracing is currently limited to [@cap-js/sqlite](https://www.npmjs.com/package/@cap-js/sqlite) and [@cap-js/hana](https://www.npmjs.com/package/@cap-js/hana).



## Telemetry Signals

TODO

### Traces

TODO

### Metrics

TODO

### Logs

Exporting logs via OpenTelemetry is not yet supported.



## Predefined Kinds

There are three predefined kinds as follows:

### `telemetry-to-console`

Prints traces and metrics to the console like so:

```
[odata] - GET /odata/v4/processor/Incidents 
[telemetry] - elapsed times:
    0.00 →   2.85 =   2.85 ms  GET /odata/v4/processor/Incidents
    0.47 →   1.24 =   0.76 ms    ProcessorService - READ ProcessorService.Incidents
    0.78 →   1.17 =   0.38 ms      db - READ ProcessorService.Incidents
    0.97 →   1.06 =   0.09 ms        @cap-js/sqlite - prepare SELECT json_object('ID',ID,'createdAt',createdAt,'creat…
    1.10 →   1.13 =   0.03 ms        @cap-js/sqlite - stmt.all SELECT json_object('ID',ID,'createdAt',createdAt,'crea…
    1.27 →   1.88 =   0.61 ms    ProcessorService - READ ProcessorService.Incidents.drafts
    1.54 →   1.86 =   0.32 ms      db - READ ProcessorService.Incidents.drafts
    1.74 →   1.78 =   0.04 ms        @cap-js/sqlite - prepare SELECT json_object('ID',ID,'DraftAdministrativeData_Dra…
    1.81 →   1.85 =   0.04 ms        @cap-js/sqlite - stmt.all SELECT json_object('ID',ID,'DraftAdministrativeData_Dr…
```

No additional dependencies are needed.
This is the default kind in both development and production.

### `telemetry-to-dynatrace`

Exports traces and metrics to Dynatrace.
Hence, a Dynatrace instance is required and the app must be bound to that Dynatrace instance.

Use via `cds.requires.telemetry.kind = 'to-dynatrace'`.

Required additional dependencies:
- `@opentelemetry/exporter-trace-otlp-proto`
- `@opentelemetry/exporter-metrics-otlp-proto`

The necessary scopes for exporting traces (`openTelemetryTrace.ingest`) and metrics (`metrics.ingest`) are not part of the standard `apitoken` and must be requested.
This can be done via parameterizing the binding to a "managed service instance" (i.e., not a user-provided service instance) as follows.

Excerpt from example mta.yaml:
```yaml
requires:
  - name: my-dynatrace-instance
    parameters:
      config:
        tokens:
          - name: ingest_apitoken #> default lookup name, configurable via cds.requires.telemetry.token_name
            scopes:
              - openTelemetryTrace.ingest
              - metrics.ingest
```

In the user-provided service case, you'll need to generate a token in Dynatrace with the necessary scopes, add it to the credentials of the user-provided service, and configure `cds.requires.telemetry.token_name` if the token's key in the credentials object is not `ingest_apitoken`.

In Dynatrace itself, you need to ensure that the following two features are enabled:
1. OpenTelemetry Node.js Instrumentation agent support:
    - From the Dynatrace menu, go to Settings > Preferences > OneAgent features.
    - Find and turn on OpenTelemetry Node.js Instrumentation agent support.
2. W3C Trace Context:
    - From the Dynatrace menu, go to Settings > Server-side service monitoring > Deep monitoring > Distributed tracing.
    - Turn on Send W3C Trace Context HTTP headers.

#### Leveraging Dynatrace OneAgent

If [Dynatrace OneAgent](https://www.dynatrace.com/platform/oneagent) is present, for example on SAP BTP CF, it will collect and transport the traces created by `@cap-js/telemetry` automatically.
(Your app still needs to be bound to a Dynatrace instance, of course.)
Hence, additionally dependency `@opentelemetry/exporter-trace-otlp-proto` and scope `openTelemetryTrace.ingest` are not required.
This is actually the perferred operating model for `telemetry-to-dynatrace` as it provides a better experience than exporting via OpenTelemetry.

### `telemetry-to-cloud-logging`

Exports traces and metrics to SAP Cloud Logging.
Hence, a SAP Cloud Logging instance is required and the app must be bound to that SAP Cloud Logging instance.

Use via `cds.requires.telemetry.kind = 'to-cloud-logging'`.

Required additional dependencies:
- `@grpc/grpc-js`
- `@opentelemetry/exporter-trace-otlp-grpc`
- `@opentelemetry/exporter-metrics-otlp-grpc`

In order to receive OpenTelemetry credentials in the binding to the SAP Cloud Logging instance, you need to include the following configuration while creating the SAP Cloud Logging instance (or by updating an existing instance):
```json
{
  "ingest_otlp": {
    "enabled": true
  }
}
```

### `telemetry-to-jaeger`

Exports traces to Jaeger.

Use via `cds.requires.telemetry.kind = 'to-jaeger'`.

Required additional dependencies (As Jaeger does not support metrics, only a trace exporter is needed.):
- `@opentelemetry/exporter-trace-otlp-proto`

Provide custom credentials like so:
```jsonc
{
  "cds": {
    "requires": {
      "telemetry": {
        "kind": "telemetry-to-jaeger",
        "tracing": {
          "exporter": {
            "config": { //> this object is passed into constructor as is
              // add credentials here as decribed in
              // https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-proto
            }
          }
        }
      }
    }
  }
}
```

Run Jaeger locally via [docker](https://www.docker.com):
- Run `docker run -d --name jaeger -e COLLECTOR_ZIPKIN_HOST_PORT=:9411 -e COLLECTOR_OTLP_ENABLED=true -p 6831:6831/udp -p 6832:6832/udp -p 5778:5778 -p 16686:16686 -p 4317:4317 -p 4318:4318 -p 14250:14250 -p 14268:14268 -p 14269:14269 -p 9411:9411 jaegertracing/all-in-one:latest`
    - With this, no custom credentials are needed
- Open `localhost:16686` to see the traces



## Detailed Configuration Options

### Instrumentations

Configure via `cds.requires.telemetry.instrumentations = { <name>: { module, class, config? } }`

Default:
```json
{
  "http": {
    "module": "@opentelemetry/instrumentation-http",
    "class": "HttpInstrumentation",
    "config": {
      "ignoreIncomingPaths": [
        "/health"
      ]
    }
  }
}
```

### Sampler

Configure via `cds.requires.telemetry.tracing.sampler = { kind, root?, ratio? }`

Default:
```json
{
  "kind": "ParentBasedSampler",
  "root": "AlwaysOnSampler"
}
```

### Propagators

Configure via `cds.requires.telemetry.tracing.propagators = [<name> | { module, class, config? }]`

Default:
```json
["W3CTraceContextPropagator"]
```

### Exporters

Configure via:
- `cds.requires.telemetry.tracing.exporter = { module, class, config? }`
- `cds.requires.telemetry.metrics.exporter = { module, class, config? }`

Default:
```json
{
  {
    "kind": "telemetry-to-console",
    "tracing": {
      "module": "@cap-js/telemetry",
      "class": "ConsoleSpanExporter"
    },
    "metrics": {
      "module": "@cap-js/telemetry",
      "class": "ConsoleMetricExporter"
    }
  },
  {
    "kind": "telemetry-to-dynatrace",
    "tracing": {
      "exporter": {
        "module": "@opentelemetry/exporter-trace-otlp-proto",
        "class": "OTLPTraceExporter"
      }
    },
    "metrics": {
      "exporter": {
        "module": "@opentelemetry/exporter-metrics-otlp-proto",
        "class": "OTLPMetricExporter"
      }
    }
  },
  {
    "kind": "telemetry-to-jaeger",
    "tracing": {
      "exporter": {
        "module": "@opentelemetry/exporter-trace-otlp-proto",
        "class": "OTLPTraceExporter"
      }
    }
  }
}
```

#### Some Alternative Exporters

1. For JSON output to the console, use:
    ```json
    {
      "tracing": {
        "module": "@opentelemetry/sdk-trace-base",
        "class": "ConsoleSpanExporter"
      },
      "metrics": {
        "module": "@opentelemetry/sdk-metrics",
        "class": "ConsoleMetricExporter"
      }
    }
    ```
1. For gRPC, use:
    ```json
    {
      "tracing": {
        "module": "@opentelemetry/exporter-trace-otlp-grpc",
        "class": "OTLPTraceExporter"
      },
      
      "metrics": {
        "module": "@opentelemetry/exporter-metrics-otlp-grpc",
        "class": "OTLPMetricExporter"
      }
    }
    ```
1. For HTTP, use:
    ```json
    {
      "tracing": {
        "module": "@opentelemetry/exporter-trace-otlp-http",
        "class": "OTLPTraceExporter"
      },
      "metrics": {
        "module": "@opentelemetry/exporter-metrics-otlp-http",
        "class": "OTLPMetricExporter"
      }
    }
    ```

### Environment variables

- `NO_TELEMETRY`: Disables the plugin
- `NO_LOCATE`: Disables function location in tracing
- `OTEL_LOG_LEVEL`: If not specified, the log level of cds logger `telemetry` is used
- `OTEL_SERVICE_NAME`: If not specified, the name is determined from package.json (defaulting to "CAP Application")
- `OTEL_SERVICE_VERSION`: If not specified, the version is determined from package.json (defaulting to "1.0.0")

For the complete list of environment variables supported by OpenTelemetry, see [Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables).

Please note that `process.env.VCAP_APPLICATION` and `process.env.CF_INSTANCE_GUID`, if present, are used to determine some [Attributes](https://opentelemetry.io/docs/specs/otel/common/#attribute).



## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/telemetry/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).



## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md) at all times.



## Licensing

Copyright 2023 SAP SE or an SAP affiliate company and contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/telemetry).
