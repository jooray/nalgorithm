/**
 * Nalgorithm Web — hosted API client
 *
 * The server is same-origin, under `<app base>api/`. The session is an
 * HttpOnly cookie the browser sends by itself; the token in the login response
 * is deliberately ignored and never stored.
 */

import { verifyEvent } from 'nostr-tools/pure'
import type { SignFn } from '../nostr-login.js'
import type { MediaMeta, ScoredPost } from 'nalgorithm'
import { readDigest, type DigestRecord } from '../digest-model.js'
import { readDigestStatus, type DigestStatus } from '../digest-job-logic.js'
import {
  buildLoginTemplate,
  type Entitlement,
  type HostedSettings,
  type PlanId,
  type Schedule,
} from './logic.js'

/** Every failed call, whatever the cause. `status` is 0 when the network failed. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  /** The rest of the error body (for example `startedAt` on a 409 digest_running). */
  readonly data: Record<string, unknown>
  constructor(status: number, message: string, code?: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
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
  posts: Array<Omit<ScoredPost, 'rawEvent'> & { isNew?: boolean; media?: MediaMeta[] }>
  profiles: Record<string, FeedProfile>
  learnedPrompt?: string
  /** Unix seconds of the run this ranking came from. */
  createdAt?: number
  ageSeconds?: number
  /** True when the server answered from its stored snapshot instead of running. */
  cached?: boolean
  /** The prompt or window changed since this ranking was made. */
  settingsChanged?: boolean
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
export function digestAudioUrl(id: string): string { return endpoint(`digests/${encodeURIComponent(id)}/audio`) }

/** A conditional GET: `etag` in, and out with the server's answer; `notModified` when it was 304. */
interface Conditional {
  etag?: string
  notModified?: boolean
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  conditional?: Conditional
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(endpoint(path), {
      method,
      credentials: 'same-origin',
      // The server requires a JSON content type on every write, bodyless or not.
      headers: method === 'GET' ? (conditional?.etag ? { 'If-None-Match': conditional.etag } : undefined) : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
  } catch (err) {
    const timedOut = controller.signal.aborted
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : (err as Error).message, 'network')
  } finally {
    clearTimeout(timer)
  }

  if (conditional) {
    conditional.notModified = res.status === 304
    conditional.etag = res.headers.get('ETag') ?? undefined
    if (res.status === 304) return null as T
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
      typeof d.code === 'string' ? d.code : undefined,
      (data && typeof data === 'object' ? (data as Record<string, unknown>) : {})
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

/** Rank the feed. `force` skips the server's 2-minute "just did that" shortcut (the Refresh button). */
export function getFeed(limit = 100, force = false): Promise<FeedResponse> {
  return request<FeedResponse>('GET', `feed?limit=${limit}${force ? '&force=1' : ''}`, undefined, FEED_TIMEOUT_MS)
}

/**
 * The last ranking the server stored for this person, or null. Never ranks, never uses the daily cap.
 * With `since` (the ranking already on this device), an unchanged one answers without its posts.
 */
export async function getLatestFeed(
  since?: number | null
): Promise<FeedResponse | { unchanged: true; settingsChanged: boolean; entitlement: Entitlement } | null> {
  const res = await request<{ snapshot: Omit<FeedResponse, 'entitlement'> | null; unchanged?: boolean; settingsChanged?: boolean; entitlement: Entitlement }>(
    'GET',
    `feed/latest${since ? `?since=${since}` : ''}`
  )
  if (res.unchanged) return { unchanged: true, settingsChanged: res.settingsChanged === true, entitlement: res.entitlement }
  return res.snapshot ? { ...res.snapshot, entitlement: res.entitlement } : null
}

export function createCheckout(plan: PlanId, sats?: number): Promise<Charge> {
  return request<Charge>('POST', 'billing/checkout', sats === undefined ? { plan } : { plan, sats })
}

// ─── Link previews ───────────────────────────────────────────────────────────

/** The server's answer for one URL, unchecked: read it with `readLinkCard`. */
export function getPreview(url: string): Promise<unknown> {
  return request<unknown>('GET', `preview?url=${encodeURIComponent(url)}`)
}

/** The address of a preview image path the server issued. */
export function previewImageSrc(path: string): string {
  return endpoint(path)
}

// ─── Daily digest ────────────────────────────────────────────────────────────

export function getSchedule(): Promise<Schedule> {
  return request<Schedule>('GET', 'schedule')
}

/** `voice` and `dmFormat` may be null: the default voice, and the format of the person's last message. */
export function putSchedule(
  patch: Partial<Pick<Schedule, 'enabled' | 'time' | 'tz' | 'voice' | 'dmFormat'>>
): Promise<Schedule> {
  return request<Schedule>('PUT', 'schedule', patch)
}

/** The taste learned from the reader's likes ('' when none). */
export function getLearned(): Promise<{ prompt: string; updatedAt: string | null }> {
  return request<{ prompt: string; updatedAt: string | null }>('GET', 'learned')
}

/** Forget the learned taste; only likes from now on shape a new one. */
export function resetLearnedTaste(): Promise<unknown> {
  return request('POST', 'learned/reset')
}

/** Where a voice's short sample plays from (only the shortlisted voices have one). */
export function voiceSampleUrl(voice: string): string {
  return endpoint(`voices/${encodeURIComponent(voice)}/sample`)
}

/**
 * The newest digests. `summary` leaves out the show notes (fetched per digest
 * with `getDigest`); `etag` is the answer last seen, and an unchanged list
 * comes back as `unchanged` with no body to parse.
 */
export async function getDigests(
  limit: number,
  opts: { summary?: boolean; etag?: string } = {}
): Promise<{ unchanged: true; etag?: string } | { unchanged: false; digests: DigestRecord[]; etag?: string }> {
  const conditional: Conditional = { etag: opts.etag }
  const res = await request<{ digests: unknown[] } | null>('GET', `digests?limit=${limit}${opts.summary ? '&summary=1' : ''}`, undefined, DEFAULT_TIMEOUT_MS, conditional)
  if (conditional.notModified || !res) return { unchanged: true, etag: conditional.etag ?? opts.etag }
  const digests = Array.isArray(res.digests) ? res.digests.map(readDigest).filter((d): d is DigestRecord => d !== null) : []
  return { unchanged: false, digests, etag: conditional.etag }
}

/** One digest with its show notes. Null when the server has no such digest. */
export async function getDigest(id: string): Promise<DigestRecord | null> {
  const res = await request<unknown>('GET', `digests/${encodeURIComponent(id)}`)
  // The contract is the single object; tolerate it wrapped as { digest }.
  const body = res && typeof res === 'object' && 'digest' in res ? (res as { digest: unknown }).digest : res
  return readDigest(body)
}

/** The digest is made in the background and arrives by DM. The answer carries the job's status. */
export async function digestNow(): Promise<{ message: string; status: DigestStatus }> {
  const res = await request<{ message: string }>('POST', 'digest/now')
  return { message: res.message, status: readDigestStatus(res) }
}

/** Whether a digest is being written, since when, and how long the last one took. */
export async function getDigestStatus(): Promise<DigestStatus> {
  return readDigestStatus(await request<unknown>('GET', 'digest/status'))
}
