const cds = require('@sap/cds')
cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')
const setupTelemetry = require('../lib')
const { trace, metrics, logs } = require('@opentelemetry/api')

test('a declared SDK-2 xotel agent is rejected before any provider registration', () => {
  const dependencies = require('./bookshop/package.json').dependencies
  const savedDependency = dependencies['@sap/xotel-agent-ext-js']
  const registrations = [
    vi.spyOn(trace, 'setGlobalTracerProvider'),
    vi.spyOn(metrics, 'setGlobalMeterProvider'),
    vi.spyOn(logs, 'setGlobalLoggerProvider')
  ]
  dependencies['@sap/xotel-agent-ext-js'] = '^2'
  try {
    expect(setupTelemetry).toThrow(/xotel requires OpenTelemetry SDK 2.*@cap-js\/telemetry 2\.x/)
    for (const registration of registrations) expect(registration).not.toHaveBeenCalled()
  } finally {
    if (savedDependency === undefined) delete dependencies['@sap/xotel-agent-ext-js']
    else dependencies['@sap/xotel-agent-ext-js'] = savedDependency
    for (const registration of registrations) registration.mockRestore()
  }
})
