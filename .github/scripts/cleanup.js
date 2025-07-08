import { fetch_token } from './token.js'

const token = await fetch_token()
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const url = 'https://service-manager.cfapps.eu10.hana.ondemand.com'

const contains = 'telemetry'

const b_url = url + `/v1/service_bindings?fieldQuery=name contains '${contains}'`
const b_res = await fetch(b_url, { method: 'GET', headers })
const { items: bindings } = await b_res.json()

console.log(`Found ${bindings.length} service bindings containing '${contains}'`)

for (const binding of bindings) {
  await fetch(url + `/v1/service_bindings/${binding.id}`, { method: 'DELETE', headers })
}

const i_url = url + `/v1/service_instances?fieldQuery=name contains '${contains}'`
const i_res = await fetch(i_url, { method: 'GET', headers })
const { items: instances } = await i_res.json()

console.log(`Found ${instances.length} service instances containing '${contains}'`)

for (const instance of instances) {
  await fetch(url + `/v1/service_instances/${instance.id}`, { method: 'DELETE', headers })
}
