const cds = require('@sap/cds')

cds.on('bootstrap', app => {
  app.use('/custom/Books', async (req, res) => {
    await cds.connect.to('db')
    const books = await SELECT.from('Books')
    res.json(books)
  })
})
