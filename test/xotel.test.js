const cds = require('@sap/cds')
cds.test(__dirname + '/bookshop', '--profile', 'tracing-in-memory')

const setup = require('../lib')
const { trace, metrics, logs } = require('@opentelemetry/api')

describe('SDK-2 agent compatibility', () => {
  test('rejects xotel before attempting to register another SDK', () => {
    const dependencies = require('./bookshop/package.json').dependencies
    const saved = dependencies['@sap/xotel-agent-ext-js']
    const registrations = [
      vi.spyOn(trace, 'setGlobalTracerProvider'),
      vi.spyOn(metrics, 'setGlobalMeterProvider'),
      vi.spyOn(logs, 'setGlobalLoggerProvider')
    ]
    dependencies['@sap/xotel-agent-ext-js'] = '^2'
    try {
      expect(setup).toThrow(/requires OpenTelemetry SDK 2.*@cap-js\/telemetry 2\.x/)
      for (const registration of registrations) expect(registration).not.toHaveBeenCalled()
    } finally {
      for (const registration of registrations) registration.mockRestore()
      if (saved === undefined) delete dependencies['@sap/xotel-agent-ext-js']
      else dependencies['@sap/xotel-agent-ext-js'] = saved
    }
  })
})
