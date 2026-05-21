const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { trace } = require('@opentelemetry/api')
const {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL
} = require('@opentelemetry/semantic-conventions')

const wrap = require('./wrap')

function _setRequestAttributes(span, requestConfig, destination) {
  if (!requestConfig) return

  const { method, url } = requestConfig

  if (method) span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method)

  // build full URL from destination and request path
  const baseUrl = typeof destination === 'string' ? undefined : destination?.url?.replace(/\/$/, '')
  if (baseUrl) {
    const fullUrl = baseUrl + (url?.startsWith('/') ? url : `/${url || ''}`)
    span.setAttribute(ATTR_URL_FULL, fullUrl)

    // parse server address and port from destination URL
    try {
      const parsed = new URL(baseUrl)
      span.setAttribute(ATTR_SERVER_ADDRESS, parsed.hostname)
      const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80)
      span.setAttribute(ATTR_SERVER_PORT, Number(port))
    } catch {
      // ignore URL parsing errors
    }
  }
}

module.exports = () => {
  cds.on('served', () => {
    let fetchClient
    try {
      fetchClient = require('@sap/cds/libx/_runtime/remote/utils/fetchClient')
    } catch {
      LOG._debug && LOG.debug('Could not load remote fetchClient module')
      return
    }

    // wrap native fetch client
    const _fetchExecute = fetchClient.executeHttpRequest
    fetchClient.executeHttpRequest = wrap(_fetchExecute, {
      wrapper: async function executeHttpRequest(destination, requestConfig) {
        const span = trace.getActiveSpan()

        // set request attributes before the call
        if (span?.isRecording()) {
          try {
            _setRequestAttributes(span, requestConfig, destination)
          } catch (err) {
            LOG._debug && LOG.debug('Failed to set HTTP request attributes:', err)
          }
        }

        // execute the actual request
        let response
        try {
          response = await _fetchExecute.apply(this, arguments)
          return response
        } catch (err) {
          // set error status code from error response
          if (span?.isRecording() && err.response?.status) {
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, err.response.status)
          }
          throw err
        } finally {
          // set success status code
          if (span?.isRecording() && response?.status) {
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status)
          }
        }
      }
    })
  })
}
