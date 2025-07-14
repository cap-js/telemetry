import { URLSearchParams } from 'url'

const fetch_token = async () => {
  const url = 'https://cdx-stakeholder-tests.authentication.eu10.hana.ondemand.com/oauth/token'

  const encodedParams = new URLSearchParams()
  encodedParams.set('grant_type', 'client_credentials')
  encodedParams.set('client_id', process.env.SM_CLIENT_ID)
  encodedParams.set('client_secret', process.env.SM_CLIENT_SECRET)

  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodedParams
  }

  const response = await fetch(url, options)
  const { access_token } = await response.json()
  return access_token
}

export { fetch_token }
