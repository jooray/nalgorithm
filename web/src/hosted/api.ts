/**
 * Nalgorithm Web — hosted API client
 *
 * The server is same-origin, under `<app base>api/`. The session is an
 * HttpOnly cookie the browser sends by itself; the token in the login response
 * is deliberately ignored and never stored.
 */

import { verifyEvent } from 'nostr-tools/pure'
import type { SignFn } from '../nostr-login.js'
import type { ScoredPost } from 'nalgorithm'
import {
  buildLoginTemplate,
  type Entitlement,
  type HostedSettings,
  type PlanId,
} from './logic.js'

/** Every failed call, whatever the cause. `status` is 0 when the network failed. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface Me {
  npub: string
  entitlement: Entitlement
}

export interface FeedProfile {
  name?: string
  picture?: string
  nip05?: string
  [key: string]: unknown
}

export interface FeedResponse {
  entitlement: Entitlement
  fetched: number
  hoursBack: number
  /** Trimmed to what the renderer needs; the raw event stays on the server. */
  posts: Array<Omit<ScoredPost, 'rawEvent'>>
  profiles: Record<string, FeedProfile>
}

export interface Charge {
  invoice_id: string
  checkout_url: string
  sats: number
  [key: string]: unknown
}

/** A feed run can take about a minute; leave room beyond that. */
const FEED_TIMEOUT_MS = 180_000
const DEFAULT_TIMEOUT_MS = 30_000

function endpoint(path: string): string {
  return new URL(path, new URL('api/', document.baseURI)).toString()
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(endpoint(path), {
      method,
      credentials: 'same-origin',
      // The server requires a JSON content type on every write, bodyless or not.
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
  } catch (err) {
    const timedOut = controller.signal.aborted
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : (err as Error).message, 'network')
  } finally {
    clearTimeout(timer)
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // Non-JSON body (a proxy error page, say): fall through to the status.
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: unknown; code?: unknown }
    throw new ApiError(
      res.status,
      typeof d.error === 'string' ? d.error : res.statusText || `HTTP ${res.status}`,
      typeof d.code === 'string' ? d.code : undefined
    )
  }
  return data as T
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Log in by signing the server's challenge.
 *
 * The challenge is fetched only now, right before signing, because the server
 * accepts a login event for about a minute after its `created_at`. The signed
 * event must be from the key the person connected: a signer that answers as
 * some other key would otherwise log them in as a stranger.
 */
export async function loginWithSigner(sign: SignFn, expectedPubkey: string): Promise<string> {
  const challenge = await request<{ nonce: string; url: string }>('POST', 'auth/challenge')
  const event = await sign(buildLoginTemplate(challenge.url, challenge.nonce, Math.floor(Date.now() / 1000)))
  if (!event || event.kind !== 27235 || !verifyEvent(event)) {
    throw new Error('The signer returned an invalid login signature.')
  }
  if (event.pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) {
    throw new Error('The signer signed with a different key than the one you connected. Try again.')
  }
  const res = await request<{ npub: string }>('POST', 'auth/login', { event })
  return res.npub
}

export async function logout(): Promise<void> {
  await request('POST', 'auth/logout')
}

export function getMe(): Promise<Me> {
  return request<Me>('GET', 'me')
}

// ─── Settings, feed, billing ─────────────────────────────────────────────────

export function getSettings(): Promise<HostedSettings> {
  return request<HostedSettings>('GET', 'settings')
}

export function putSettings(patch: Partial<HostedSettings>): Promise<HostedSettings> {
  return request<HostedSettings>('PUT', 'settings', patch)
}

export function getFeed(limit = 100): Promise<FeedResponse> {
  return request<FeedResponse>('GET', `feed?limit=${limit}`, undefined, FEED_TIMEOUT_MS)
}

export function createCheckout(plan: PlanId, sats?: number): Promise<Charge> {
  return request<Charge>('POST', 'billing/checkout', sats === undefined ? { plan } : { plan, sats })
}
