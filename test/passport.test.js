process.env.SAP_PASSPORT = 'true'

const cds = require('@sap/cds')
const { expect, GET } = cds.test().in(__dirname + '/bookshop')
// const log = cds.test.log()

describe('SAP Passport', () => {
  if (cds.env.requires.db.kind === 'sqlite') return test.skip('n/a for SQLite', () => {})

  let _passports, _count

  cds.on('connect', srv => {
    if (srv.options.kind === 'hana') {
      const { acquire } = srv
      srv.acquire = async function () {
        const dbc = await acquire.apply(this, arguments)
        const {
          _native: { set }
        } = dbc
        dbc._native.set = function (obj) {
          if ('SAP_PASSPORT' in obj) {
            console.info('SAP_PASSPORT:', obj.SAP_PASSPORT)
            _passports.push(obj.SAP_PASSPORT)
            _count++
          }
          return set.apply(this, arguments)
        }
        return dbc
      }
    }
  })

  const admin = { auth: { username: 'alice' } }

  // beforeEach(log.clear)
  beforeEach(() => {
    _passports = []
    _count = 0
  })

  test('gets set once for simple queries', async () => {
    const { status } = await GET('/odata/v4/admin/Books', admin)
    expect(status).to.equal(200)
    console.info('_count:', _count)
    console.info('_passports:', _passports)
    // expect(_passports).to.equal([])
    expect(_count).to.equal(2)
    expect(_passports[0]).to.equal('') //> the reset
    expect(_passports[1]).to.match(/^2A54482A/)
  })

  test('gets set twice for prepared statements', async () => {
    const { status } = await GET("/odata/v4/admin/Books?$filter=title eq 'hurz'", admin)
    expect(status).to.equal(200)
    console.info('_count:', _count)
    console.info('_passports:', _passports)
    // expect(_passports).to.equal([])
    expect(_count).to.equal(3)
    expect(_passports[0]).to.equal('') //> the reset
    expect(_passports[1]).to.match(/^2A54482A/)
    expect(_passports[2]).to.match(/^2A54482A/)
    expect(_passports[1]).to.not.equal(_passports[2]) //> different for prepare and execute
  })

  test('again', async () => {
    const { status } = await GET("/odata/v4/admin/Books?$filter=title eq 'hurz'", admin)
    expect(status).to.equal(200)
    console.info('_count:', _count)
    console.info('_passports:', _passports)
    // expect(_passports).to.equal([])
    expect(_count).to.equal(3)
    expect(_passports[0]).to.equal('') //> the reset
    expect(_passports[1]).to.match(/^2A54482A/)
    expect(_passports[2]).to.match(/^2A54482A/)
    expect(_passports[1]).to.not.equal(_passports[2]) //> different for prepare and execute
  })
})
