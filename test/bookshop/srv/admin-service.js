const cds = require('@sap/cds/lib')

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const messaging = await cds.connect.to('messaging')
    messaging.on('foo', async () => {
      await SELECT.from('sap.capire.bookshop.Books')
      await cds.services.AdminService.read('Authors')
    })

    this.before('NEW', 'Books.drafts', genid)

    this.before('READ', 'Genres', () => {
      cds.log('AdminService').info('Hello, World!')
      try {
        this.doesnt.exist
      } catch (err) {
        err.foo = 'bar'
        cds.log('AdminService').error('Oh no!', err)
      }
      cds.log('AdminService').error({ message: 'Error-like oh no!', foo: 'bar' }, new Error('dummy'))
    })

    this.on('test_spawn', () => {
      cds.spawn({ after: 3 }, async () => {
        await SELECT.from('sap.capire.bookshop.Books')
        await cds.services.AdminService.read('Authors')
      })
    })

    this.on('test_emit', async () => {
      await messaging.emit('foo', { bar: 'baz' })
    })

    // test_outboxed_send: writes a task to the persistent outbox addressed to ExternalServiceOne,
    // whose handler the test installs. Exercises the queue-worker path (scan, lock, dispatch).
    this.on('test_outboxed_send', async () => {
      const externalOne = await cds.connect.to('ExternalServiceOne')
      await cds.queued(externalOne).send('call', {})
    })

    // test_outboxed_send_batch: writes multiple tasks to the persistent outbox to exercise chunkSize > 1 fan-out.
    this.on('test_outboxed_send_batch', async () => {
      const externalOne = await cds.connect.to('ExternalServiceOne')
      const queued = cds.queued(externalOne)
      await Promise.all([
        queued.send('call', {}),
        queued.send('call', {}),
        queued.send('call', {})
      ])
    })

    // test_scheduled: schedules a one-shot task to fire after a short delay.
    this.on('test_scheduled', async () => {
      const externalOne = await cds.connect.to('ExternalServiceOne')
      await cds.queued(externalOne).schedule('call', {}).after(10)
    })

    return super.init()
  }
}

/** Generate primary keys for target entity in request */
async function genid(req) {
  const { ID } = await cds.tx(req).run(SELECT.one.from(req.target.actives).columns('max(ID) as ID'))
  req.data.ID = ID - (ID % 100) + 100 + 1
}
