# Welcome to @cap-js/opentelemetry-instrumentation

## About this project

`@cap-js/opentelemetry-instrumentation` is a CDS plugin providing [automatic OpenTelemetry instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/automatic).

Documentation can be found at [cap.cloud.sap](https://cap.cloud.sap/docs) and [opentelemetry.io](https://opentelemetry.io/docs).

## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/opentelemetry-instrumentation/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2023 SAP SE or an SAP affiliate company and contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/opentelemetry-instrumentation).

## Setup - TODO

Add `@cap-js/opentelemetry-instrumentation` to your dependencies.

TODO: Which modules must be installed per feature?

## Configuration options - TODO

### Instrumentation range

- Set the log level for the cds logger `app` to `trace`, to trace individual CAP handler
- With log level `info` of `cds` the handling function in each Service is traced, including DB Services 
- Annotate services with `@cds.tracing : false` to disable all tracing for that service. Counterwise, you can enable only the tracing for one service with `@cds.tracing : true`. The exception is detailed OData Adapter tracing, which can only be enabled or disabled globally. At the moment the annotation also only disables all CAP tracing, but not the HTTP and Express tracing. 
- Use `const { instrumentations } = require('@cap-js/opentelemetry-instrumentation')` to adjust the instrumentations which are used by this plugin. By default HTTP, Express and HDB instrumentations are used
- By default the middlewares of express are not traced. You can override this, by overriding `cds.env.trace.ignoreExpressLayer`. Allowed values are 'router', 'middleware' or 'request_handler'. For more information see [ExpressInstrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-express)
- Muting the log level for 'otel' will disable the plugin

### Exporter

Locally the default exporter is a custom console exporter.
With the following setting you get the normal console exporter output from OTEL in the form of larger json objects:
```
"trace": {
  "format": "json"
}
```
You can also manually specify the exporter:
```
"trace": {
  "export": "jaeger" | "http" | "grpc" | "proto"
}
```
With `cds.env.trace.ignorePaths` you can specify an array of endpoints which shall be excluded. By default it is `/health`

### Details

- In production the BatchSpanProcessor, locally SimpleSpanProcessor is used.
- For Jaeger locally run `docker run -d --name jaeger -e COLLECTOR_ZIPKIN_HOST_PORT=:9411 -e COLLECTOR_OTLP_ENABLED=true -p 6831:6831/udp -p 6832:6832/udp -p 5778:5778 -p 16686:16686 -p 4317:4317 -p 4318:4318 -p 14250:14250 -p 14268:14268 -p 14269:14269 -p 9411:9411 jaegertracing/all-in-one:latest` and open `localhost:16686` to see the traces.
- Due to the tracing initial requests might be slower, locally all requests are slower due to the sync writing to the console.
- In CF Environments `process.env.VCAP_APPLICATION` and `process.env.CF_INSTANCE_GUID` are used to determine the appropriate Resource Attributes

### Environment variables

- OTEL_SDK_DISABLED | Disables all tracing
- OTEL_RESOURCE_ATTRIBUTES | Specify additional resource attributes. Per specification the "user defined" attributes, e.g. what CAP defines, has higher priority
- OTEL_SERVICE_NAME | Allows to override the name identified CAP. CAP will use the package.json name and version
- OTEL_LOG_LEVEL | Override the log level for OTEL, by default log level of cds logger `trace` is used
- OTEL_TRACES_EXPORTER | Override the exporter type
- OTEL_PROPAGATORS | Override propagator. Default is W3CTraceContextPropagator
- OTEL_TRACES_SAMPLER | Default is ParentBasedSampler with Root AlwaysOn
- OTEL_TRACES_SAMPLER_ARG | For TraceId ratio

[Batch Span processor config](https://opentelemetry.io/docs/reference/specification/sdk-environment-variables/#batch-span-processor):
- OTEL_BSP_SCHEDULE_DELAY | Override default OTEL value
- OTEL_BSP_EXPORT_TIMEOUT | Override default OTEL value
- OTEL_BSP_MAX_QUEUE_SIZE | Override default OTEL value
- OTEL_BSP_MAX_EXPORT_BATCH_SIZE | Override default OTEL value

Should all work, as no explizit configuration is provided by this package:
- OTEL_EXPORTER_OTLP_ENDPOINT
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
- OTEL_EXPORTER_OTLP_TRACES_TIMEOUT
- OTEL_EXPORTER_OTLP_TIMEOUT
- DEFAULT_EXPORT_MAX_ATTEMPTS
- DEFAULT_EXPORT_INITIAL_BACKOFF
- DEFAULT_EXPORT_MAX_BACKOFF
- DEFAULT_EXPORT_BACKOFF_MULTIPLIER

## Troubleshooting - TODO

### Plugin does not load

If upon server startup you do not see the message `[cds] - loaded plugin: { impl: '@cap-js/opentelemetry-instrumentation/cds-plugin' }`, please add  
```
"plugins": [
  "./node_modules/@cap-js/opentelemetry-instrumentation/cds-plugin"
]
```
to your cds configuration, like:
```
cds : {
  ...,
  "plugins": [
    "./node_modules/@cap-js/opentelemetry-instrumentation/cds-plugin"
  ],
  ...
}
```
This ensures that the plugin is loaded.
