process.env.SAP_PASSPORT = 'true'

const cds = require('@sap/cds')
const { expect, GET } = cds.test().in(__dirname + '/bookshop')

describe('SAP Passport', () => {
  if (cds.env.requires.db.kind === 'sqlite') return test.skip('n/a for SQLite', () => {})

  const admin = { auth: { username: 'alice' } }

  cds.on('connect', async service => {
    if (service.kind === 'hana') {
      const { acquire } = service
      service.acquire = async function () {
        const dbc = await acquire.apply(this, arguments)
        if (!dbc._native.set._patched) {
          const { set } = dbc._native
          dbc._native.set = function (obj) {
            if ('SAP_PASSPORT' in obj) {
              _passports.push(obj.SAP_PASSPORT)
              _count++
            }
            return set.apply(this, arguments)
          }
          dbc._native.set._patched = true
        }
        return dbc
      }
    }
  })

  let _passports, _count
  beforeEach(() => {
    _passports = []
    _count = 0
  })

  test('gets set once for simple queries', async () => {
    const { status } = await GET('/odata/v4/admin/Books?$select=ID,title', admin)
    expect(status).to.equal(200)
    expect(_count).to.equal(2)
    expect(_passports[0]).to.equal('') //> the reset
    expect(_passports[1]).to.match(/^2A54482A/)
  })

  test('gets set twice for prepared statements', async () => {
    const { status } = await GET("/odata/v4/admin/Books?$select=ID,title&$filter=title eq 'hurz'", admin)
    expect(status).to.equal(200)
    expect(_count).to.equal(3)
    expect(_passports[0]).to.equal('') //> the reset
    expect(_passports[1]).to.match(/^2A54482A/)
    expect(_passports[2]).to.match(/^2A54482A/)
    expect(_passports[1]).to.not.equal(_passports[2]) //> different for prepare and execute
  })
})
