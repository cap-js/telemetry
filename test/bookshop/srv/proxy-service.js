const cds = require('@sap/cds')

class ProxyService extends cds.ApplicationService {
  async init() {
    const externalService = await cds.connect.to('ExternalService')
    const outboxedService = cds.outboxed(externalService)

    this.on('proxyCallToExternalService', async req => {
        await outboxedService.send('call', {})
        return req.reply('OK')
    })

    return super.init();
  }
}

module.exports = ProxyService
