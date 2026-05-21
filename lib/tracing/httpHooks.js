const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { trace, context } = require('@opentelemetry/api')
const {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL
} = require('@opentelemetry/semantic-conventions')

// Attributes to propagate from HTTP span to parent CDS span
const HTTP_CLIENT_ATTRS = [
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL
]

/**
 * Response hook for @opentelemetry/instrumentation-undici (and instrumentation-http)
 * Propagates HTTP client attributes from the HTTP span to the parent CDS span
 */
function responseHook(span, response) {
  try {
    // Only process client spans (outbound requests)
    // SpanKind: 0=INTERNAL, 1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER
    if (span.kind !== 2) return

    // The responseHook runs in the context of the HTTP span's parent
    // So trace.getSpan(context.active()) gives us the CDS span
    const parentSpan = trace.getSpan(context.active())
    if (!parentSpan || parentSpan === span) return

    // Only propagate to CDS spans (from @cap-js/telemetry)
    const instLib = parentSpan.instrumentationLibrary?.name
    if (instLib !== '@cap-js/telemetry') return

    // Check if parent is recording
    if (!parentSpan.isRecording()) return

    // Propagate HTTP attributes to parent span
    for (const attr of HTTP_CLIENT_ATTRS) {
      const value = span.attributes[attr]
      if (value !== undefined) {
        parentSpan.setAttribute(attr, value)
      }
    }
  } catch (err) {
    LOG._debug && LOG.debug('Failed to propagate HTTP attributes:', err)
  }
}

module.exports = { responseHook }
