const trace = require('./trace')
const wrap = require('./wrap')

// REVISIT: unverified!
module.exports = () => {
  try {
    require.resolve('@sap-cloud-sdk/http-client')
  } catch {
    return
  }

  const cloudSDK = require('@sap-cloud-sdk/http-client')
  const { executeHttpRequest: _execute, executeHttpRequestWithOrigin: _executeWithOrigin } = cloudSDK
  cloudSDK.executeHttpRequest = wrap(_execute, {
    wrapper: function executeHttpRequest(destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        _execute,
        this,
        arguments,
        { outbound: destination.name }
      )
    }
  })
  cloudSDK.executeHttpRequestWithOrigin = wrap(_executeWithOrigin, {
    wrapper: function executeHttpRequestWithOrigin(destination, requestConfig) {
      return trace(
        `${destination?.name ? destination?.name + ' ' : ''}${requestConfig?.method || 'GET'} ${
          destination.url || requestConfig?.url
        }`,
        _executeWithOrigin,
        this,
        arguments,
        { outbound: destination.name }
      )
    }
  })
}
