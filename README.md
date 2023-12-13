# Welcome to @cap-js/opentelemetry-instrumentation

## About this project

`@cap-js/opentelemetry-instrumentation` is a CDS plugin providing [automatic OpenTelemetry instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/automatic).

Documentation can be found at [cap.cloud.sap](https://cap.cloud.sap/docs) and [opentelemetry.io](https://opentelemetry.io/docs).

## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.



## Setup - TODO

Add `@cap-js/opentelemetry-instrumentation` to your dependencies.

TODO:
- Prerequisites?
- Which modules must be installed per feature?

### Run Jaeger locally

- Run `docker run -d --name jaeger -e COLLECTOR_ZIPKIN_HOST_PORT=:9411 -e COLLECTOR_OTLP_ENABLED=true -p 6831:6831/udp -p 6832:6832/udp -p 5778:5778 -p 16686:16686 -p 4317:4317 -p 4318:4318 -p 14250:14250 -p 14268:14268 -p 14269:14269 -p 9411:9411 jaegertracing/all-in-one:latest`
- Open `localhost:16686` to see the traces



## Predefined Kinds

There are three predefined kinds:

### `telemetry-to-console`

Prints traces and logs to the console.

No additional dependencies needed.

The default kind in both development and production.

### `telemetry-to-dyntrace`

Exports traces and metrics to Dynatrace.
Hence, a Dynatrace instance is required and the app must be bound to a Dynatrace instance.

Use via `cds.requires.telemetry.kind = 'telemetry-to-dyntrace'`.

Required additional dependencies:
- `@dynatrace/oneagent-sdk`
- `@opentelemetry/exporter-trace-otlp-proto`
- `@opentelemetry/exporter-metrics-otlp-proto`

The necessary scope for exporting metrics (`metrics.ingest`) is not part of the standard `apitoken` and must be requested.
This can only be done via binding to a "managed service instance", i.e., not a user-provided instance.
There are two config options: (1) `rest_apitoken` (to be deprecated) and (2) `metrics_apitoken` via `tokens`.
Example (you only need one):
```yaml
requires:
  - name: my-dynatrace-instance
    parameters:
      config:
        # option 1
        rest_apitoken:
          scopes: ['metrics.ingest']
        # option 2
        tokens:
          - name: metrics_apitoken
            scopes:
              - metrics.ingest
```

### `telemetry-to-jaeger`

Exports traces to Jaeger. Jaeger does not support metrics!

Use via `cds.requires.telemetry.kind = 'telemetry-to-jaeger'`.

Required additional dependencies:
- `@opentelemetry/exporter-trace-otlp-proto`

Provide custom credentials like so:
```jsonc
{
  "cds": {
    "requires": {
      "telemetry": {
        "kind": "telemetry-to-jaeger",
        "tracing": {
          "config": {
            // add credentials here as decribed in https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-proto
          }
        }
      }
    }
  }
}
```



## Configuration Options

### Instrumentations

TODO: add more info

Configure via `cds.requires.telemetry.instrumentations = { name: { module, class, config? } }`

Default:
```
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

TODO: no longer default:
```
{
  "express": {
    "module": "@opentelemetry/instrumentation-express",
    "class": "ExpressInstrumentation",
    "config": {
      "ignoreLayersType": [
        "middleware"
      ]
    }
  }
}
```

#### Http

Via `cds.env.requires.telemetry.instrumentations.http.ignoreIncomingPaths`, you can specify an array of endpoints which shall be excluded.

#### Express

By default the middlewares of express are not traced.
You can override this via `cds.env.requires.telemetry.instrumentations.express.ignoreLayersType`.
Allowed values are `router`, `middleware`, and `request_handler`.
For more information see [ExpressInstrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-express)

### Sampler

TODO: add more info

Configure via `cds.requires.telemetry.tracing.sampler = { kind, root?, ratio? }`

Default:
```
{
  "kind": "ParentBasedSampler",
  "root": "AlwaysOnSampler"
}
```

### Propagators

TODO: add more info

Configure via `cds.requires.telemetry.tracing.propagators = [<name> | { module, class, config? }]`

Default:
```
["W3CTraceContextPropagator"]
```



### Exporters

TODO: add more info

Configure via:
- `cds.requires.telemetry.tracing.exporter = { module, class, config? }`
- `cds.requires.telemetry.metrics.exporter = { module, class, config? }`

Default:
```
{
  "tracing": {
    "module": "@cap-js/opentelemetry-instrumentation",
    "class": "ConsoleSpanExporter"
  },
  "metrics": {
    "module": "@cap-js/opentelemetry-instrumentation",
    "class": "ConsoleMetricExporter"
  }
}
```

#### Some Alternative Exporters

1. For JSON output to the console, use:
    ```
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
1. For Jaeger (on Kyma or locally via Docker image), use:
    ```
    {
      "_tracing": {
        "module": "@opentelemetry/exporter-jaeger",
        "class": "JaegerExporter"
      },
      "tracing": {
        "module": "@opentelemetry/exporter-trace-otlp-proto",
        "class": "OTLPTraceExporter"
      },
      "metrics": { ??? }
    }
    ```
1. For gRPC (CLS???), use:
    ```
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
1. For Proto (Dynatrace), use:
    ```
    {
      "tracing": {
        "module": "@opentelemetry/exporter-trace-otlp-proto",
        "class": "OTLPTraceExporter"
      },
      "metrics": {
        "module": "@opentelemetry/exporter-metrics-otlp-proto",
        "class": "OTLPMetricExporter"
      }
    }
    ```
1. For HTTP (???), use:
    ```
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
- `OTEL_LOG_LEVEL`: If not specified, the log level of cds logger `otel` is used
- `OTEL_SERVICE_NAME`: If not specified, the name is determined from package.json (defaulting to "CAP Application")
- `OTEL_SERVICE_VERSION`: If not specified, the version is determined from package.json (defaulting to "1.0.0")

For the complete list of environment variables supported by OpenTelemetry, see [Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables).

Please note that `process.env.VCAP_APPLICATION` and `process.env.CF_INSTANCE_GUID`, if present, are used to determine some [Attributes](https://opentelemetry.io/docs/specs/otel/common/#attribute).



### Instrumentation range - TODO

- Set the log level for the cds logger `app` to `trace`, to trace individual CAP handler
- With log level `info` of `cds` the handling function in each Service is traced, including DB Services 
- Annotate services with `@cds.tracing : false` to disable all tracing for that service. Counterwise, you can enable only the tracing for one service with `@cds.tracing : true`. The exception is detailed OData Adapter tracing, which can only be enabled or disabled globally. At the moment the annotation also only disables all CAP tracing, but not the HTTP and Express tracing.



## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/opentelemetry-instrumentation/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).



## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md) at all times.



## Licensing

Copyright 2023 SAP SE or an SAP affiliate company and contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/opentelemetry-instrumentation).