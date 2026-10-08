const cds = require('@sap/cds')

/*
 * SAP performance statistics response headers -> span attributes
 *
 * Requested with request header `sap-statistics: true` (or URL parameter `sap-statistics=true`),
 * SAP Gateway, ICM and Web Dispatcher answer with `sap-statistics`, the Cloud Connector with
 * `sap-statistics-scc` and OData provisioning on BTP with `sap-statistics-hciodp`. Each value is a
 * comma separated list of `<field>=<milliseconds>`. Node joins repeated headers with ", ", which
 * the parser tolerates. Gateway sends its statistics only for successfully processed requests.
 *
 * Written per request to the http client spans of @opentelemetry/instrumentation-http (hooked in
 * lib/index.js), e.g. separately for the csrf HEAD and the POST of one cloud sdk call.
 *
 * Configuration: cds.requires.telemetry.tracing.sap_statistics
 *   false              -> off
 *   { mode: 'raw' }    -> one attribute per header with the unparsed value
 *                           sap.statistics     = "total=42,gwtotal=40,gwhub=5,gwbe=30"
 *                           sap.statistics_scc = "openRemoteConn=3,ext=35,total=41"
 *   { mode: 'fields' } -> one numeric attribute per field (default)
 *                           sap.statistics.total = 42, sap.statistics_scc.ext = 35, ...
 *   { mode: 'both' }   -> raw and fields
 */

const HEADER_PREFIX = 'sap-statistics'
const MODES = { raw: 1, fields: 1, both: 1 }
// package.json sets the normal CDS default; this fallback covers missing or invalid custom settings.
const FALLBACK_MODE = 'fields'

let _config
function _getConfig() {
  if (_config !== undefined) return _config
  const sap_statistics = cds.env.requires.telemetry?.tracing?.sap_statistics
  if (sap_statistics === false) return (_config = false)
  const mode = sap_statistics?.mode
  return (_config = { mode: MODES[mode] ? mode : FALLBACK_MODE })
}

function _setFields(span, rawValue, prefix) {
  for (const part of rawValue.split(',')) {
    const [rawKey, rawValue_] = part.split('=')
    const key = rawKey?.trim()
    const value = rawValue_?.trim()
    if (!key || !value) continue
    const parsed = Number.parseInt(value)
    if (Number.isNaN(parsed)) continue
    span.setAttribute(`${prefix}.${key}`, parsed)
  }
}

/**
 * @param {import('@opentelemetry/api').Span} span
 * @param {Record<string, unknown>} headers response headers (lower-case names as delivered by node/axios)
 * @param {{ mode?: 'raw' | 'fields' | 'both' }} [options] overrides the configured mode
 */
function setSapStatisticsAttributes(span, headers, options) {
  if (!span || !headers || typeof headers !== 'object') return
  const mode = MODES[options?.mode] ? options.mode : _getConfig()?.mode
  if (!mode) return

  for (const [name, value] of Object.entries(headers)) {
    const header = String(name).toLowerCase()
    if (!header.startsWith(HEADER_PREFIX) || value == null) continue
    const raw = Array.isArray(value) ? value.join(',') : String(value)
    // sap-statistics -> sap.statistics, sap-statistics-scc -> sap.statistics_scc
    const prefix = header.replace('-', '.').replace(/-/g, '_')
    if (mode !== 'fields') span.setAttribute(prefix, raw)
    if (mode !== 'raw') _setFields(span, raw, prefix)
  }
}

module.exports = { setSapStatisticsAttributes }