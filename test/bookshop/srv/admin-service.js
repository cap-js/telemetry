const cds = require('@sap/cds/lib')

module.exports = class AdminService extends cds.ApplicationService { init(){
  this.before ('NEW','Books.drafts', genid)

  this.before('READ', 'Genres', () => {
    cds.log('AdminService').info('Hello, World!')
  })

  this.on('spawn', () => {
    cds.spawn({ after: 3 }, async () => {
      await SELECT.from('sap.capire.bookshop.Books')
      await cds.services.AdminService.read('Authors')
    })
  })

  return super.init()
}}

/** Generate primary keys for target entity in request */
async function genid (req) {
  const {ID} = await cds.tx(req).run (SELECT.one.from(req.target.actives).columns('max(ID) as ID'))
  req.data.ID = ID - ID % 100 + 100 + 1
}
