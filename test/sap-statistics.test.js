const cds = require('@sap/cds')
const { setSapStatisticsAttributes } = require('../lib/tracing/sap_statistics')

const fakeSpan = () => {
  const attributes = {}
  return { attributes, setAttribute: (key, value) => (attributes[key] = value) }
}

const GATEWAY =
  'wdtotal=120,wdssl=10,wdreqrcv=2,wdext=100,icmtotal=98,icmssl=0,icmreqrcv=1,icmext=90,gwtotal=85,gwhub=5,gwrfcoh=0,gwbe=10,gwapp=70,gwnongw=0,fw=15,app=70,total=85,gwbewait=0,gwappsum=70'
const SCC = 'openRemoteConn=3,ext=95,total=101'
const HCIODP = 'hciodp=12,nwoh=20,gwbe=10,gwapp=70,fw=42,total=112'

const fieldsOf = (prefix, raw) =>
  Object.fromEntries(raw.split(',').map(part => part.split('=')).map(([key, value]) => [`${prefix}.${key}`, Number(value)]))

describe('setSapStatisticsAttributes', () => {
  it('mode both: raw header plus one numeric attribute per field, for all three headers', () => {
    const span = fakeSpan()
    setSapStatisticsAttributes(
      span,
      {
        'sap-statistics': GATEWAY,
        'sap-statistics-scc': SCC,
        'sap-statistics-hciodp': HCIODP,
        'content-type': 'application/json'
      },
      { mode: 'both' }
    )
    expect(span.attributes).toEqual({
      'sap.statistics': GATEWAY,
      ...fieldsOf('sap.statistics', GATEWAY),
      'sap.statistics_scc': SCC,
      ...fieldsOf('sap.statistics_scc', SCC),
      'sap.statistics_hciodp': HCIODP,
      ...fieldsOf('sap.statistics_hciodp', HCIODP)
    })
    expect(Object.keys(span.attributes)).toHaveLength(31)
  })

  it('mode raw: only the unparsed header values', () => {
    const span = fakeSpan()
    setSapStatisticsAttributes(span, { 'sap-statistics': GATEWAY, 'sap-statistics-scc': SCC }, { mode: 'raw' })
    expect(span.attributes).toEqual({ 'sap.statistics': GATEWAY, 'sap.statistics_scc': SCC })
  })

  it('mode fields: only the numeric fields', () => {
    const span = fakeSpan()
    setSapStatisticsAttributes(span, { 'sap-statistics-scc': SCC }, { mode: 'fields' })
    expect(span.attributes).toEqual(fieldsOf('sap.statistics_scc', SCC))
  })

  it('defaults to fields mode when no override is given', () => {
    const span = fakeSpan()
    expect(cds.env.requires.telemetry.tracing.sap_statistics).toEqual({ mode: 'fields' })
    setSapStatisticsAttributes(span, { 'sap-statistics': 'total=3' })
    expect(span.attributes).toEqual({ 'sap.statistics.total': 3 })
  })

  it('tolerates repeated headers joined by node, spaces, upper case and non-numeric parts', () => {
    const span = fakeSpan()
    setSapStatisticsAttributes(
      span,
      { 'SAP-Statistics': 'wdtotal=120, gwtotal = 85 ,note=abc,broken' },
      { mode: 'fields' }
    )
    expect(span.attributes).toEqual({ 'sap.statistics.wdtotal': 120, 'sap.statistics.gwtotal': 85 })
  })

  it('accepts array header values and ignores missing span or headers', () => {
    const span = fakeSpan()
    setSapStatisticsAttributes(span, { 'sap-statistics': ['total=1', 'fw=2'] }, { mode: 'fields' })
    expect(span.attributes).toEqual({ 'sap.statistics.total': 1, 'sap.statistics.fw': 2 })
    setSapStatisticsAttributes(span, undefined)
    setSapStatisticsAttributes(undefined, { 'sap-statistics': 'total=9' })
    expect(span.attributes['sap.statistics.total']).toBe(1)
  })
})