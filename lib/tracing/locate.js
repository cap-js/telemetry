const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { Session } = require('inspector')
const { promisify } = require('util')
const { uuid } = cds.utils

const locations = new WeakMap()

module.exports = async fn => {
  if (locations.has(fn)) return locations.get(fn)

  let session
  const script_urls = {}
  const random = `__${uuid().replace(/-/g, '_')}__`
  try {
    global[random] = fn
    session = new Session()
    session.connect()
    session.on('Debugger.scriptParsed', result => {
      script_urls[result.params.scriptId] = result.params.url
    })
    const session_post = promisify(session.post).bind(session)
    await session_post('Debugger.enable')
    const { result: { objectId } } = await session_post('Runtime.evaluate', { expression: random })
    const { internalProperties } = await session_post('Runtime.getProperties', { objectId })
    const function_location = internalProperties.find(({ name }) => name === '[[FunctionLocation]]')
    const location = {
      url: script_urls[function_location.value.value.scriptId],
      line: function_location.value.value.lineNumber + 1,
      column: function_location.value.value.columnNumber + 1
    }
    locations.set(fn, location)
    return location
  } catch (err) {
    LOG.warn(`Unable to locate function "${fn.name}" due to error:`, err)
  } finally {
    session?.disconnect()
    delete global[random]
  }
}
