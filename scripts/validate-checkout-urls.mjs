import { pathToFileURL } from 'node:url'

const EXPECTED_HOST = 'store.nerionapp.com'
const CHECKOUT_PATH = /^\/buy\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

function responseCookies(headers) {
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = headers.get?.('set-cookie')
  return combined ? combined.split(/,(?=\s*[^;,\s]+=)/) : []
}

function rememberCookies(jar, headers) {
  for (const value of responseCookies(headers)) {
    const pair = value.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
  }
}

async function fetchCheckout(startUrl, fetchImpl) {
  let currentUrl = new URL(startUrl)
  const cookies = new Map()

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    }
    if (cookies.size > 0) {
      headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }

    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers,
    })
    rememberCookies(cookies, response.headers)

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: new URL(response.url || currentUrl) }
    }

    const location = response.headers?.get?.('location')
    if (!location) throw new Error(`Checkout returned HTTP ${response.status} without a redirect location.`)
    currentUrl = new URL(location, currentUrl)
    if (currentUrl.protocol !== 'https:' || currentUrl.hostname !== EXPECTED_HOST) {
      throw new Error(`Checkout redirected outside ${EXPECTED_HOST}.`)
    }
  }

  throw new Error(`Checkout exceeded ${MAX_REDIRECTS} redirects.`)
}

export function readBillingReleaseConfig(env = process.env) {
  const checkouts = [
    { name: 'Monthly', rawUrl: env.VITE_MONTHLY_CHECKOUT_URL },
    { name: 'Lifetime', rawUrl: env.VITE_LIFETIME_CHECKOUT_URL },
  ].map(({ name, rawUrl }) => {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      throw new Error(`${name} checkout URL is missing from the release environment.`)
    }
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error(`${name} checkout URL is malformed.`)
    }
    if (url.protocol !== 'https:' || url.hostname !== EXPECTED_HOST || !CHECKOUT_PATH.test(url.pathname)) {
      throw new Error(`${name} checkout must use the HTTPS ${EXPECTED_HOST}/buy/<UUID> share-link format.`)
    }
    return { name, url }
  })

  for (const name of ['VITE_MONTHLY_VARIANT_ID', 'VITE_LIFETIME_VARIANT_ID']) {
    const value = Number(env[name])
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive numeric Lemon Squeezy variant ID.`)
    }
  }

  return checkouts
}

export async function validateBillingReleaseConfig(env = process.env, fetchImpl = fetch) {
  const checkouts = readBillingReleaseConfig(env)
  for (const { name, url } of checkouts) {
    const { response, finalUrl } = await fetchCheckout(url, fetchImpl)
    if (!response.ok || finalUrl.protocol !== 'https:' || finalUrl.hostname !== EXPECTED_HOST) {
      throw new Error(`${name} checkout is unavailable (HTTP ${response.status}). Refresh its Share URL in Lemon Squeezy.`)
    }
  }
  return checkouts.map(({ name }) => `${name} checkout is reachable.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateBillingReleaseConfig()
    .then((messages) => messages.forEach((message) => console.log(message)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
