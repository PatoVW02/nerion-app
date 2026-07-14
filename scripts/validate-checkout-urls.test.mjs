import { describe, expect, it, vi } from 'vitest'
import { readBillingReleaseConfig, validateBillingReleaseConfig } from './validate-checkout-urls.mjs'

const validEnv = {
  VITE_MONTHLY_CHECKOUT_URL: 'https://store.nerionapp.com/buy/8cd4a398-e637-4e34-881d-ae1c159f2279',
  VITE_LIFETIME_CHECKOUT_URL: 'https://store.nerionapp.com/buy/f9e6a1ab-6be5-432b-82e0-0894d3992f73',
  VITE_MONTHLY_VARIANT_ID: '101',
  VITE_LIFETIME_VARIANT_ID: '202',
}

describe('billing release configuration', () => {
  it('accepts reachable HTTPS checkouts and positive variant IDs', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      url: url.toString(),
    }))

    await expect(validateBillingReleaseConfig(validEnv, fetchImpl)).resolves.toEqual([
      'Monthly checkout is reachable.',
      'Lifetime checkout is reachable.',
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('preserves checkout cookies while following redirects', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        url: validEnv.VITE_MONTHLY_CHECKOUT_URL,
        headers: {
          get: (name) => name === 'location' ? 'https://store.nerionapp.com/checkout' : null,
          getSetCookie: () => ['ls_cart_id=cart-id; Path=/; Secure'],
        },
      })
      .mockImplementationOnce(async (url, options) => {
        expect(options.headers.Cookie).toBe('ls_cart_id=cart-id')
        return { ok: true, status: 200, url: url.toString() }
      })
      .mockImplementationOnce(async (url, options) => {
        expect(options.headers.Cookie).toBeUndefined()
        return { ok: true, status: 200, url: url.toString() }
      })

    await expect(validateBillingReleaseConfig(validEnv, fetchImpl)).resolves.toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('blocks a checkout that redirects to an error response', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: false,
      status: 404,
      url: url.toString(),
    }))

    await expect(validateBillingReleaseConfig(validEnv, fetchImpl)).rejects.toThrow('HTTP 404')
  })

  it('blocks foreign hosts, missing URLs, and invalid variant IDs', () => {
    expect(() => readBillingReleaseConfig({
      ...validEnv,
      VITE_MONTHLY_CHECKOUT_URL: 'https://example.com/buy/8cd4a398-e637-4e34-881d-ae1c159f2279',
    })).toThrow('store.nerionapp.com')
    expect(() => readBillingReleaseConfig({
      ...validEnv,
      VITE_LIFETIME_CHECKOUT_URL: '',
    })).toThrow('missing from the release environment')
    expect(() => readBillingReleaseConfig({
      ...validEnv,
      VITE_MONTHLY_VARIANT_ID: 'not-a-number',
    })).toThrow('positive numeric')
    expect(() => readBillingReleaseConfig({
      ...validEnv,
      VITE_MONTHLY_CHECKOUT_URL: 'https://store.nerionapp.com/checkout/buy/8cd4a398-e637-4e34-881d-ae1c159f2279',
    })).toThrow('/buy/<UUID>')
    expect(() => readBillingReleaseConfig({
      ...validEnv,
      VITE_MONTHLY_CHECKOUT_URL: 'https://store.nerionapp.com/buy/monthly',
    })).toThrow('/buy/<UUID>')
  })
})
