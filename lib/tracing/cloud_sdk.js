const { SpanKind } = require('@opentelemetry/api')

const cds = require('@sap/cds')
const trace = require('./trace')
const wrap = require('./wrap')

const { _append_url_path } = cds.env.requires.telemetry.tracing
const APPEND_URL_PATH = _append_url_path && _append_url_path !== 'false'

function _cloudSdkSpanName(destination, requestConfig) {
  const method = requestConfig?.method || 'GET'
  if (!APPEND_URL_PATH) return method
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
  const _executeHttpRequest = wrap(_execute, {
    wrapper: function executeHttpRequest(destination, requestConfig) {
      return trace(_cloudSdkSpanName(destination, requestConfig), _execute, this, arguments, {
        kind: SpanKind.CLIENT,
        outbound: destination.name
      })
    }
  })
  Object.defineProperty(cloudSDK, 'executeHttpRequest', { value: _executeHttpRequest })
  const _executeHttpRequestWithOrigin = wrap(_executeWithOrigin, {
    wrapper: function executeHttpRequestWithOrigin(destination, requestConfig) {
      return trace(_cloudSdkSpanName(destination, requestConfig), _executeWithOrigin, this, arguments, {
        kind: SpanKind.CLIENT,
        outbound: destination.name
      })
    }
  })
  Object.defineProperty(cloudSDK, 'executeHttpRequestWithOrigin', { value: _executeHttpRequestWithOrigin })
}
