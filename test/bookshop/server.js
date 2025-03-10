const cds = require('@sap/cds')

cds.on('bootstrap', app => {
  app.use('/custom/Books', async (req, res) => {
    const books = await SELECT.from('Books')
    res.json(books)
  })
})
