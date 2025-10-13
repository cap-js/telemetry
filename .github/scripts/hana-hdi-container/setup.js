import { promisify } from 'node:util'
const sleep = promisify(setTimeout)

import { join as path_join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { fetch_token } from './token.js'

const token = await fetch_token()
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const url = 'https://service-manager.cfapps.eu10.hana.ondemand.com'

const i_url = url + '/v1/service_instances'
const i_name = `telemetry_ci_${Math.random().toString(36).substring(2, 15)}`
const i_options = {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: i_name,
    service_plan_id: 'fa787a6e-4e35-461a-ac5d-4189a2cf8084'
  })
}
const i_res = await fetch(i_url, i_options)
const i_loc = i_res.headers.get('location')
const service_instance_id = i_loc.split('/')[3]

for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const res = await fetch(url + i_loc, { method: 'GET', headers })
  const { state } = await res.json()
  if (state === 'succeeded') break
}

const b_url = url + '/v1/service_bindings'
const b_name = i_name + '_binding'
const b_options = {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: b_name,
    service_instance_id
  })
}
const b_res = await fetch(b_url, b_options)
const b_loc = b_res.headers.get('location')
const service_binding_id = b_loc.split('/')[3]

for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const res = await fetch(url + b_loc, { method: 'GET', headers })
  const { state } = await res.json()
  if (state === 'succeeded') break
}

const res = await fetch(b_url + '/' + service_binding_id, { method: 'GET', headers })
const { credentials } = await res.json()

const cdsrc = path_join(process.cwd(), 'test', 'bookshop', '.cdsrc.json')
writeFileSync(cdsrc, JSON.stringify({ requires: { db: { kind: 'hana', credentials } } }, null, 2))

const vcap = path_join(process.cwd(), 'test', 'bookshop', 'vcap.json')
writeFileSync(vcap, JSON.stringify({ VCAP_SERVICES: { hana: [{ tags: ['hana'], credentials }] } }, null, 2))
