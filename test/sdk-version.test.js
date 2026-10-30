const api = require('@opentelemetry/api')
const { SDK_INFO } = require('@opentelemetry/core')

test('the installed OpenTelemetry family is SDK 3 with the integrated logs API', () => {
  expect(SDK_INFO['telemetry.sdk.version']).toMatch(/^3\./)
  expect(api.logs.getLoggerProvider).toBeTypeOf('function')
  expect(api.SeverityNumber.INFO).toBe(9)
})
