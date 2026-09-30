/**
 * Link previews for hosted mode: a card (title, description, image) for a URL
 * that appears in a post.
 *
 * A browser cannot do this itself, because other sites do not allow scripts on
 * a different origin to read their pages (CORS). The server can. Everything a
 * page says is public, so results are cached once for everybody and no user
 * is recorded with a URL.
 *
 * Images are not hotlinked by the reader's browser, which would tell the image
 * host who reads what. They are served through `/preview/image`, and only
 * for image URLs that came out of a preview parse: the path carries the image
 * URL and an HMAC of it under a secret that only this process knows, so a
 * caller cannot make the server fetch a URL of their own choosing.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { upsert } from '../database.js'
import type { Db } from '../db.js'
import { parsePreview } from './parse.js'
import { PreviewFetchError, safeFetch } from './ssrf.js'
import type { GuardOptions, Transport } from './ssrf.js'

export const PREVIEW_TTL_SECONDS = 7 * 86_400
export const NEGATIVE_TTL_SECONDS = 3600
/** A failure that may pass on its own (network, timeout, server error) is remembered only briefly. */
export const TRANSIENT_TTL_SECONDS = 120
export const PREVIEWS_PER_MINUTE = 60
export const IMAGES_PER_MINUTE = 240
export const CONCURRENCY = 4
export const MAX_QUEUE = 50
export const HTML_MAX_BYTES = 1024 * 1024
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024
const MAX_URL_LENGTH = 2048

/** Raised for caller mistakes (400), rate limits (429) and overload (503). */
export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface PreviewCard {
  url: string
  finalUrl: string
  title: string
  description: string
  siteName: string
  /** Path under the API base, served by this server; empty when the page has no usable image. */
  image: string
  type: string
}

export type PreviewResult = PreviewCard | { unavailable: true }

export interface PreviewOptions {
  db: Db
  /** Milliseconds. Injected by tests. */
  nowMs?: () => number
  /** Resolver, transport and the tests-only loopback switch, passed through to the fetcher. */
  fetch?: GuardOptions & { transport?: Transport; timeoutMs?: number }
  /** Hosts never previewed (the app's own). A leading `.` is not needed: subdomains match too. */
  skipHosts?: string[]
  /** Defaults to a random secret per process; image paths from before a restart stop working, which only costs a re-fetch. */
  secret?: Buffer
  previewsPerMinute?: number
  imagesPerMinute?: number
  concurrency?: number
  maxQueue?: number
}

const MEDIA_PATH = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico|mp4|webm|mov|m4v|ogv|ogg|mp3|wav|flac|m4a|aac|opus)$/i

/** Parse for use as a cache key: http(s) only, no fragment. Throws PreviewError(400). */
export function normalizeUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new PreviewError(400, 'invalid url')
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new PreviewError(400, 'invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PreviewError(400, 'invalid url')
  u.hash = ''
  return u.toString()
}

class SlidingWindow {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  /** Records a hit and returns true, or returns false when `key` is over its limit. */
  take(key: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(t)
    this.hits.set(key, recent)
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v[v.length - 1] <= t - this.windowMs) this.hits.delete(k)
    return true
  }
}

/** At most `limit` jobs run at once; the rest wait in a bounded queue. */
class Gate {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new PreviewError(503, 'busy')
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    } else {
      this.active++
    }
    try {
      return await job()
    } finally {
      const next = this.waiting.shift()
      if (next) next() // hands the slot over without releasing it
      else this.active--
    }
  }
}

const hashUrl = (url: string): string => createHash('sha256').update(url).digest('hex')
const b64url = (b: Buffer): string => b.toString('base64url')

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The type the bytes really are, from their magic numbers. SVG and anything else is refused. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

export function createPreviewService(opts: PreviewOptions) {
  const { db } = opts
  const nowMs = opts.nowMs ?? Date.now
  const nowSec = (): number => Math.floor(nowMs() / 1000)
  const secret = opts.secret ?? randomBytes(32)
  const skipHosts = (opts.skipHosts ?? []).map((h) => h.toLowerCase())
  const previewLimit = new SlidingWindow(opts.previewsPerMinute ?? PREVIEWS_PER_MINUTE, 60_000, nowMs)
  const imageLimit = new SlidingWindow(opts.imagesPerMinute ?? IMAGES_PER_MINUTE, 60_000, nowMs)
  const gate = new Gate(opts.concurrency ?? CONCURRENCY, opts.maxQueue ?? MAX_QUEUE)
  const inflight = new Map<string, Promise<StoredCard | null>>()

  interface StoredCard extends Omit<PreviewCard, 'image'> {
    /** The image's own URL. Signed into a path only when a card is handed out. */
    imageUrl: string
  }

  const sign = (imageUrl: string): string => b64url(createHmac('sha256', secret).update(imageUrl).digest())
  const imagePath = (imageUrl: string): string =>
    imageUrl ? `preview/image?u=${b64url(Buffer.from(imageUrl))}&s=${sign(imageUrl)}` : ''
  const toCard = (c: StoredCard): PreviewCard => {
    const { imageUrl, ...rest } = c
    return { ...rest, image: imagePath(imageUrl) }
  }

  function skipped(url: string): boolean {
    const u = new URL(url)
    if (MEDIA_PATH.test(u.pathname)) return true
    const host = u.hostname.toLowerCase()
    return skipHosts.some((h) => host === h || host.endsWith(`.${h}`))
  }

  /** A card, or null. `transient` marks a null that may pass on its own, so it is not remembered for long. */
  async function fetchCard(url: string): Promise<{ card: StoredCard | null; transient: boolean }> {
    try {
      const res = await safeFetch(url, {
        ...opts.fetch,
        accept: 'text/html,application/xhtml+xml',
        acceptType: (t) => t === 'text/html' || t === 'application/xhtml+xml',
        maxBytes: HTML_MAX_BYTES,
        truncate: true,
      })
      const p = parsePreview(res.body.toString('utf8'), res.finalUrl)
      if (!p.title && !p.description) return { card: null, transient: false }
      const host = new URL(res.finalUrl).hostname.replace(/^www\./, '')
      return { card: { url, finalUrl: res.finalUrl, title: p.title, description: p.description, siteName: p.siteName || host, imageUrl: p.image, type: p.type }, transient: false }
    } catch (err) {
      if (err instanceof PreviewFetchError) {
        const transient = err.code === 'network' || err.code === 'timeout' || (err.code === 'status' && /status (5\d\d|429)/.test(err.message))
        return { card: null, transient }
      }
      throw err
    }
  }

  async function store(hash: string, card: StoredCard | null, transient = false): Promise<void> {
    // Backdating fetched_at makes the ordinary age check expire a transient miss
    // after TRANSIENT_TTL_SECONDS without a schema change.
    const stamp = transient ? nowSec() - (NEGATIVE_TTL_SECONDS - TRANSIENT_TTL_SECONDS) : nowSec()
    await db.run(upsert(db, 'link_previews', ['url_hash', 'found', 'data', 'fetched_at'], ['url_hash'], ['found', 'data', 'fetched_at']), [
      hash,
      card ? 1 : 0,
      card ? JSON.stringify(card) : null,
      stamp,
    ])
  }

  return {
    /** The card for `rawUrl`, `{unavailable: true}` when there is nothing to show. `who` is only used for the rate limit. */
    async preview(who: string, rawUrl: string): Promise<PreviewResult> {
      const url = normalizeUrl(rawUrl)
      if (!previewLimit.take(who)) throw new PreviewError(429, 'too many previews, slow down')
      if (skipped(url)) return { unavailable: true }

      const hash = hashUrl(url)
      const row = await db.get<{ found: number; data: string | null; fetched_at: number }>(
        'SELECT found, data, fetched_at FROM link_previews WHERE url_hash = ?',
        [hash],
      )
      if (row) {
        const age = nowSec() - Number(row.fetched_at)
        if (Number(row.found) === 1 && row.data && age < PREVIEW_TTL_SECONDS) {
          try {
            return toCard(JSON.parse(row.data) as StoredCard)
          } catch {
            // A damaged row is treated as a miss.
          }
        } else if (Number(row.found) !== 1 && age < NEGATIVE_TTL_SECONDS) {
          return { unavailable: true }
        }
      }

      let pending = inflight.get(hash)
      if (!pending) {
        pending = gate
          .run(async () => {
            const { card, transient } = await fetchCard(url)
            await store(hash, card, transient)
            return card
          })
          .finally(() => inflight.delete(hash))
        inflight.set(hash, pending)
      }
      const card = await pending
      return card ? toCard(card) : { unavailable: true }
    },

    /**
     * The bytes of a preview image. `u` and `s` are the two query values of an
     * image path this service issued; anything else is refused with 404.
     */
    async image(who: string, u: string, s: string): Promise<{ type: string; body: Buffer }> {
      let imageUrl = ''
      try {
        imageUrl = Buffer.from(u, 'base64url').toString('utf8')
      } catch {
        // falls through to the signature check
      }
      const want = Buffer.from(sign(imageUrl))
      const got = Buffer.from(typeof s === 'string' ? s : '')
      if (!imageUrl || got.length !== want.length || !timingSafeEqual(want, got)) throw new PreviewError(404, 'not found')
      if (!imageLimit.take(who)) throw new PreviewError(429, 'too many images, slow down')
      try {
        const res = await gate.run(() =>
          safeFetch(imageUrl, {
            ...opts.fetch,
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            acceptType: (t) => IMAGE_TYPES.has(t),
            maxBytes: IMAGE_MAX_BYTES,
            truncate: false,
          }),
        )
        const type = sniffImage(res.body)
        if (!type) throw new PreviewError(404, 'not found')
        return { type, body: res.body }
      } catch (err) {
        if (err instanceof PreviewFetchError) throw new PreviewError(404, 'not found')
        throw err
      }
    },

    /** Delete cache rows older than the longest time they are used. Returns rows removed. */
    async prune(): Promise<number> {
      return (await db.run('DELETE FROM link_previews WHERE fetched_at < ?', [nowSec() - PREVIEW_TTL_SECONDS])).changes
    },
  }
}

export type PreviewService = ReturnType<typeof createPreviewService>
