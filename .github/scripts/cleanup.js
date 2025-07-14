import { fetch_token } from './token.js'

const token = await fetch_token()
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const url = 'https://service-manager.cfapps.eu10.hana.ondemand.com'

const contains = 'telemetry'
const AGE = 1000 * 60 * 60 * 1 // 1 hour

const b_url = url + `/v1/service_bindings?fieldQuery=name contains '${contains}'`
const b_res = await fetch(b_url, { method: 'GET', headers })
let { items: bindings } = await b_res.json()
bindings = bindings.filter(b => Date.now() - new Date(b.created_at) > AGE)

console.log(`>>> Found ${bindings.length} old service bindings containing '${contains}'`)

for (const binding of bindings) {
  await fetch(url + `/v1/service_bindings/${binding.id}`, { method: 'DELETE', headers })
}

const i_url = url + `/v1/service_instances?fieldQuery=name contains '${contains}'`
const i_res = await fetch(i_url, { method: 'GET', headers })
let { items: instances } = await i_res.json()
instances = instances.filter(i => Date.now() - new Date(i.created_at) > AGE)

console.log(`>>> Found ${instances.length} old service instances containing '${contains}'`)

for (const instance of instances) {
  await fetch(url + `/v1/service_instances/${instance.id}`, { method: 'DELETE', headers })
}
