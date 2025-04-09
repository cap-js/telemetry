process.env.SAP_PASSPORT = 'true'

const cds = require('@sap/cds')
const { expect, GET } = cds.test().in(__dirname + '/bookshop')
const log = cds.test.log()

describe('SAP Passport', () => {
  let _session_vars, _count

  cds.on('connect', srv => {
    if (srv.options.kind === 'sqlite') {
      const { acquire } = srv
      srv.acquire = async function () {
        const dbc = await acquire.apply(this, arguments)
        dbc.set ??= o => {
          _session_vars = Object.assign(_session_vars || {}, o)
          _count++
        }
        return dbc
      }
    }
  })

  const admin = { auth: { username: 'alice' } }

  beforeEach(log.clear)
  beforeEach(() => {
    _session_vars = undefined
    _count = 0
  })

  test('gets set', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    expect(_session_vars).to.containSubset({ SAP_PASSPORT: s => s.match(/^2A54482A/) })
    expect(_count).to.equal(2)
  })
})
