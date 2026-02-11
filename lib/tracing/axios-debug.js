const cds = require('@sap/cds')
const axios = require('axios')

let _initialized = false

/**
 * Setup axios-debug-log mit OpenTelemetry Span Integration
 */
function setupAxiosTracing() {
    if (_initialized) return
    _initialized = true

    const LOG = cds.log('axios-telemetry')

    // Dynamisch axios-debug-log laden und konfigurieren
    require('axios-debug-log')({
        request: (debug, config) => {
            const span = _startSpan(config)
            config._otelSpan = span
            config._startTime = Date.now()

            debug(
                `Request: ${config.method?.toUpperCase()} ${config.url}`,
                config.headers ? `Headers: ${JSON.stringify(config.headers)}` : ''
            )
        },
        response: (debug, response) => {
            const { config } = response
            const duration = Date.now() - (config._startTime || Date.now())

            _endSpan(config._otelSpan, response.status, duration)

            debug(
                `Response: ${response.status} ${response.statusText}`,
                `Duration: ${duration}ms`
            )
        },
        error: (debug, error) => {
            const config = error.config || {}
            const duration = Date.now() - (config._startTime || Date.now())

            _endSpanWithError(config._otelSpan, error, duration)

            debug(
                `Error: ${error.message}`,
                error.response ? `Status: ${error.response.status}` : ''
            )
        }
    })

    // Interceptors für alle axios Instanzen
    _addGlobalInterceptors()

    LOG.debug('axios-debug-log configured with OpenTelemetry spans')
}

/**
 * Wrap eine einzelne axios Instanz mit Tracing
 * @param {import('axios').AxiosInstance} instance 
 * @returns {import('axios').AxiosInstance}
 */
function wrapAxiosInstance(instance) {
    const LOG = cds.log('axios-telemetry')

    instance.interceptors.request.use(
        (config) => {
            const span = _startSpan(config)
            config._otelSpan = span
            config._startTime = Date.now()

            // Trace Context Propagation
            _injectTraceContext(config)

            return config
        },
        (error) => {
            LOG.error('Request interceptor error:', error.message)
            return Promise.reject(error)
        }
    )

    instance.interceptors.response.use(
        (response) => {
            const { config } = response
            const duration = Date.now() - (config._startTime || Date.now())
            _endSpan(config._otelSpan, response.status, duration)
            return response
        },
        (error) => {
            const config = error.config || {}
            const duration = Date.now() - (config._startTime || Date.now())
            _endSpanWithError(config._otelSpan, error, duration)
            return Promise.reject(error)
        }
    )

    return instance
}

/**
 * Startet einen neuen OpenTelemetry Span für den Request
 */
function _startSpan(config) {
    try {
        // @cap-js/telemetry nutzt @opentelemetry/api
        const { trace, SpanKind } = require('@opentelemetry/api')
        const tracer = trace.getTracer('cds-plugin-axios-telemetry')

        const url = new URL(config.url, config.baseURL || 'http://localhost')
        const spanName = `HTTP ${config.method?.toUpperCase()} ${url.pathname}`

        const span = tracer.startSpan(spanName, {
            kind: SpanKind.CLIENT,
            attributes: {
                'http.method': config.method?.toUpperCase(),
                'http.url': url.href,
                'http.target': url.pathname + url.search,
                'http.host': url.host,
                'http.scheme': url.protocol.replace(':', ''),
                'net.peer.name': url.hostname,
                'net.peer.port': url.port || (url.protocol === 'https:' ? 443 : 80)
            }
        })

        return span
    } catch (e) {
        // OpenTelemetry nicht verfügbar - graceful degradation
        return null
    }
}

/**
 * Beendet den Span mit Success Status
 */
function _endSpan(span, statusCode, duration) {
    if (!span) return

    try {
        const { SpanStatusCode } = require('@opentelemetry/api')

        span.setAttribute('http.status_code', statusCode)
        span.setAttribute('http.response_time_ms', duration)

        if (statusCode >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR })
        } else {
            span.setStatus({ code: SpanStatusCode.OK })
        }

        span.end()
    } catch (e) {
        // Ignore errors
    }
}

/**
 * Beendet den Span mit Error Status
 */
function _endSpanWithError(span, error, duration) {
    if (!span) return

    try {
        const { SpanStatusCode } = require('@opentelemetry/api')

        span.setAttribute('http.response_time_ms', duration)
        span.setAttribute('error', true)
        span.setAttribute('error.message', error.message)
        span.setAttribute('error.type', error.name || 'Error')

        if (error.response) {
            span.setAttribute('http.status_code', error.response.status)
        }

        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message
        })

        span.recordException(error)
        span.end()
    } catch (e) {
        // Ignore errors
    }
}

/**
 * Injiziert W3C Trace Context Header für Distributed Tracing
 */
function _injectTraceContext(config) {
    try {
        const { trace, context, propagation } = require('@opentelemetry/api')

        config.headers = config.headers || {}
        propagation.inject(context.active(), config.headers)
    } catch (e) {
        // Ignore if OpenTelemetry not available
    }
}

/**
 * Fügt globale Interceptors zur default axios Instanz hinzu
 */
function _addGlobalInterceptors() {
    wrapAxiosInstance(axios)
}

module.exports = {
    setupAxiosTracing,
    wrapAxiosInstance
}