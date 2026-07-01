const { SpanKind } = require('@opentelemetry/api')

const cds = require('@sap/cds')
const trace = require('./trace')
const wrap = require('./wrap')

const { adjust_root_name } = cds.env.requires.telemetry.tracing
const ADJUST_ROOT_NAME = adjust_root_name && adjust_root_name !== 'false'

function _cloudSdkSpanName(destination, requestConfig) {
  const method = requestConfig?.method || 'GET'
  if (!ADJUST_ROOT_NAME) return method
  const url = destination.url || requestConfig?.url || ''
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  return `${method}${path ? ' ' + path : ''}`
}

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
        _cloudSdkSpanName(destination, requestConfig),
        _execute,
        this,
        arguments,
        { kind: SpanKind.CLIENT, outbound: destination.name }
      )
    }
  })
  cloudSDK.executeHttpRequestWithOrigin = wrap(_executeWithOrigin, {
    wrapper: function executeHttpRequestWithOrigin(destination, requestConfig) {
      return trace(
        _cloudSdkSpanName(destination, requestConfig),
        _executeWithOrigin,
        this,
        arguments,
        { kind: SpanKind.CLIENT, outbound: destination.name }
      )
    }
  })
}
