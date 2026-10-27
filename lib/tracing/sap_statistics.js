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
 * Written per request onto the http client spans of @opentelemetry/instrumentation-http and
 * @opentelemetry/instrumentation-undici (hooked in lib/index.js), e.g. separately for the csrf
 * HEAD and the POST of one cloud sdk call.
 *
 * Opt-in via cds.requires.telemetry.tracing.sap_statistics (off unless enabled):
 *   false / unset      -> off
 *   true               -> on with the default mode (fields)
 *   { mode: 'raw' }    -> one attribute per header with the unparsed value
 *                           sap.statistics     = "total=42,gwtotal=40,gwhub=5,gwbe=30"
 *                           sap.statistics_scc = "openRemoteConn=3,ext=35,total=41"
 *   { mode: 'fields' } -> one numeric attribute per field (default)
 *                           sap.statistics.total = 42, sap.statistics_scc.ext = 35, ...
 *   { mode: 'both' }   -> raw and fields
 */

// the recognized SAP statistics response headers, mapped to their span-attribute prefix; an exact
// allowlist so an untrusted server can't inject arbitrary `sap-statistics*` attributes (cardinality)
const HEADERS = {
  'sap-statistics': 'sap.statistics',
  'sap-statistics-scc': 'sap.statistics_scc',
  'sap-statistics-hciodp': 'sap.statistics_hciodp'
}
const MODES = { raw: 1, fields: 1, both: 1 }
const DEFAULT_MODE = 'fields'

let _config
function _getConfig() {
  if (_config !== undefined) return _config
  const sap_statistics = cds.env.requires.telemetry?.tracing?.sap_statistics
  if (!sap_statistics) return (_config = false) //> off by default (false / unset)
  if (sap_statistics === true) return (_config = { mode: DEFAULT_MODE })
  return (_config = { mode: MODES[sap_statistics.mode] ? sap_statistics.mode : DEFAULT_MODE })
}

// cheap gate for the hooks in lib/index.js to skip per-request work (e.g. header normalization)
// while the feature is off, which is the default
function isSapStatisticsEnabled() {
  return !!_getConfig()
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
 * Normalize undici's raw response headers to the lower-cased `{ name: value }` object shape that
 * the http instrumentation already delivers, so one writer serves both. undici's responseHook
 * passes headers as a flat `Buffer[]` of `[name, value, name, value, ...]`; repeated names are
 * joined with ',' to match how node merges repeated headers for the http path.
 * @param {Buffer[]} rawHeaders
 */
function headersFromUndici(rawHeaders) {
  const headers = {}
  if (!Array.isArray(rawHeaders)) return headers
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase()
    const value = String(rawHeaders[i + 1])
    headers[name] = name in headers ? `${headers[name]},${value}` : value
  }
  return headers
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
    const prefix = HEADERS[String(name).toLowerCase()]
    if (!prefix || value == null) continue
    const raw = Array.isArray(value) ? value.join(',') : String(value)
    if (mode !== 'fields') span.setAttribute(prefix, raw)
    if (mode !== 'raw') _setFields(span, raw, prefix)
  }
}

module.exports = { setSapStatisticsAttributes, headersFromUndici, isSapStatisticsEnabled }
