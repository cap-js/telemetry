const { hrTimeToMilliseconds } = require('@opentelemetry/core')

const now = Date.now()
const hrTimeInMS = Number(`${hrTimeToMilliseconds(process.hrtime())}`.split('.')[0])
const diff = now - hrTimeInMS
const EPOCH_OFFSET_S = Number(`${diff}`.slice(0, -3))
const EPOCH_OFFSET_MS = Number(`${diff}`.slice(-3) + '000000')

// returns [seconds, nanoseconds] since unix epoch
function _hrnow() {
  const hrtime = process.hrtime()
  let s = hrtime[0] + EPOCH_OFFSET_S
  let ns = hrtime[1] + EPOCH_OFFSET_MS
  if (ns >= 1000000000) {
    s++
    ns -= 1000000000
  }
  return [s, ns]
}

// Parse a queue `timestamp` value to epoch millis, robust to the DB driver's format.
// Direct column reads return an ISO-8601 UTC string ("...Z"), but HANA's min()/max()
// aggregates return a timezone-naive string ("2026-08-13 22:50:41.2270000" — space
// separator, sub-ms digits, no zone). Passing that straight to `new Date()` parses it as
// LOCAL time, so storage-time gauges were off by the machine's UTC offset on HANA (e.g. 7200s
// in CEST). Normalize naive strings to UTC before parsing; ISO/Date/number inputs pass through.
function timestampToEpoch(ts) {
  if (ts == null) return null
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts
  let s = String(ts).trim()
  // Already zoned (ends with Z or ±HH:MM / ±HHMM)? leave as-is; otherwise treat as UTC.
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    // "YYYY-MM-DD HH:MM:SS.fffffff" -> "YYYY-MM-DDTHH:MM:SS.fffZ" (trim sub-ms to 3 digits)
    s = s.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1') + 'Z'
  }
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

module.exports = {
  _hrnow,
  timestampToEpoch
}
