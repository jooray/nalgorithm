/**
 * Client for the billing service, with the failure policy from the billing
 * spec: entitlements are cached for 60 s, served stale for up to 24 h when
 * billing is unreachable, and unknown otherwise. A billing outage therefore
 * costs a paid feature only for users we have never seen, never a free one.
 */

export type State = 'active' | 'trial' | 'expired' | 'none' | 'unknown'

export interface ProductState {
  state: State
  until?: number
}

export class BillingUnavailable extends Error {}

export interface BillingClientOptions {
  url: string
  token: string
  product: string
  fetch?: typeof fetch
  now?: () => number
  freshSeconds?: number
  staleSeconds?: number
  /** After a failure, skip live calls for this long (default 10 s). */
  breakerSeconds?: number
}

interface CacheEntry {
  value: ProductState
  fetchedAt: number
}

export function createBillingClient(opts: BillingClientOptions) {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const fresh = opts.freshSeconds ?? 60
  const stale = opts.staleSeconds ?? 86_400
  const breaker = opts.breakerSeconds ?? 10
  const cache = new Map<string, CacheEntry>()
  let downUntil = 0

  async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    let res: Response
    try {
      res = await doFetch(`${opts.url}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}`, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      downUntil = now() + breaker
      throw new BillingUnavailable((err as Error).message)
    }
    if (res.status >= 500 || res.status === 429) {
      downUntil = now() + breaker
      throw new BillingUnavailable(`billing answered ${res.status}`)
    }
    let body: any = null
    try {
      body = await res.json()
    } catch {
      // empty body
    }
    return { status: res.status, body }
  }

  /** An elapsed `until` is expired no matter how the state was cached. */
  function checked(value: ProductState): ProductState {
    if ((value.state === 'active' || value.state === 'trial') && value.until !== undefined && value.until <= now()) {
      return { state: 'expired', until: value.until }
    }
    return value
  }

  async function entitlement(npub: string): Promise<ProductState> {
    const hit = cache.get(npub)
    if (hit && now() - hit.fetchedAt < fresh) return checked(hit.value)

    if (now() >= downUntil) {
      try {
        const { status, body } = await call(`/v1/entitlement/${encodeURIComponent(npub)}`)
        if (status !== 200) throw new Error(`billing answered ${status}`)
        const value = (body?.products?.[opts.product] ?? { state: 'none' }) as ProductState
        cache.set(npub, { value, fetchedAt: now() })
        return checked(value)
      } catch (err) {
        if (!(err instanceof BillingUnavailable)) throw err
      }
    }
    if (hit && now() - hit.fetchedAt < stale) return checked(hit.value)
    return { state: 'unknown' }
  }

  return {
    entitlement,

    /** Drop the cached state, for example right after a payment or trial start. */
    forget(npub: string): void {
      cache.delete(npub)
    },

    /**
     * Start the one-time trial, then re-read the state. A 409 (already started,
     * used or active) is not an error: the re-read decides.
     */
    async startTrial(npub: string): Promise<ProductState> {
      const { status } = await call('/v1/trials', { method: 'POST', body: JSON.stringify({ npub, product: opts.product }) })
      if (status !== 200 && status !== 409) throw new Error(`billing answered ${status} to trial start`)
      cache.delete(npub)
      return entitlement(npub)
    },

    /**
     * Count units against the daily safety cap. On an outage a known-active user
     * is allowed (a paying user must not be blocked by our failure); anyone else
     * is denied.
     */
    async consume(npub: string, kind: string, units = 1, key?: string): Promise<{ allowed: boolean; reason?: string }> {
      try {
        const { status, body } = await call('/v1/consume', {
          method: 'POST',
          body: JSON.stringify({ npub, product: opts.product, kind, units, ...(key ? { key } : {}) }),
        })
        if (status !== 200) throw new Error(`billing answered ${status} to consume`)
        return { allowed: Boolean(body.allowed), reason: body.reason }
      } catch (err) {
        if (!(err instanceof BillingUnavailable)) throw err
        const known = cache.get(npub)
        if (known?.value.state === 'active') return { allowed: true }
        return { allowed: false, reason: 'billing_unavailable' }
      }
    },

    async createCharge(npub: string, plan: string, sats?: number): Promise<{ invoice_id: string; checkout_url?: string }> {
      const { status, body } = await call('/v1/charges', {
        method: 'POST',
        body: JSON.stringify({ npub, plan, ...(sats ? { sats } : {}) }),
      })
      if (status !== 200) throw new Error(`billing answered ${status} to charge`)
      return body
    },
  }
}

export type BillingClient = ReturnType<typeof createBillingClient>
