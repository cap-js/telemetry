const cds = require('@sap/cds')

// try {
//   const dynatrace = process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES).dynatrace?.[0]?.credentials
//   require('@dynatrace/oneagent')({
//     environmentid: dynatrace.environmentid,
//     apitoken: dynatrace.apitoken,
//     endpoint: dynatrace.apiurl // specify endpoint url - not needed for SaaS customers
//   })
// } catch (err) {
//   console.log('Failed to load OneAgent: ', err)
// }

module.exports = cds.server
