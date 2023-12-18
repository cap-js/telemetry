const cds = require('@sap/cds')
const LOG = cds.log('cds')

const trace = require('./trace')
const wrap = require('./wrap')

module.exports = () => {
  try {
    require.resolve('@sap-cloud-sdk/http-client')
  } catch {
    return
  }

  const cloudSDK = require('@sap-cloud-sdk/http-client')
  const { executeHttpRequest: _execute, executeHttpRequestWithOrigin: _executeWithOrigin } = cloudSDK
  cloudSDK.executeHttpRequest = wrap(_execute, {
    wrapper: function (destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        _execute,
        this,
        arguments,
        { loggerName: LOG.label, outbound: destination.name }
      )
    }
  })
  cloudSDK.executeHttpRequestWithOrigin = wrap(_executeWithOrigin, {
    wrapper: function (destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        _executeWithOrigin,
        this,
        arguments,
        { loggerName: LOG.label, outbound: destination.name }
      )
    }
  })
}
