/**
 * Fetching other people's pages on behalf of a user, without letting the user
 * aim the server at its own network.
 *
 * The rules, in the order they apply to every request and every redirect hop:
 *  1. http or https only, no credentials in the URL, port 80 or 443 only.
 *  2. The hostname is resolved here, and if ANY address it resolves to is not a
 *     public unicast address the request is refused.
 *  3. The connection goes to the address that was vetted (the resolver result is
 *     pinned through the socket's `lookup`), so a DNS answer that changes
 *     between the check and the connect cannot swap in another address. The Host
 *     header and the TLS server name still carry the hostname.
 *  4. Redirects are followed at most 3 times, each one through steps 1 to 3,
 *     and never from https to http.
 *  5. One deadline covers the whole exchange, the body is read only up to a byte
 *     cap, only accepted content types are read, and no cookies are sent or kept.
 *
 * The resolver and the transport are injectable so tests never touch the network.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

export class PreviewFetchError extends Error {
  constructor(
    readonly code: 'blocked' | 'invalid' | 'redirects' | 'downgrade' | 'status' | 'type' | 'timeout' | 'network' | 'size',
    message: string,
  ) {
    super(message)
  }
}

// ─── Address classification ──────────────────────────────────────────────────

type Bytes = number[]

/** Strict dotted-decimal IPv4. The URL parser has already turned 2130706433, 0x7f.1 and 0177.0.0.1 into this form. */
function parseIPv4(text: string): Bytes | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out: Bytes = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** IPv6 text (no brackets, no zone) to 16 bytes, including an embedded dotted IPv4 tail. */
function parseIPv6(input: string): Bytes | null {
  let text = input
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (isIP(text) !== 6) return null

  let tail: Bytes = []
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (!v4) return null
    tail = v4
    text = `${text.slice(0, lastColon + 1)}0:0`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (s: string): number[] => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)))
  const head = groups(halves[0])
  const rest = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - head.length - rest.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const all = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest]
  if (all.length !== 8 || all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  const bytes = all.flatMap((g) => [g >> 8, g & 255])
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

function blockedV4(b: Bytes, allowLoopback: boolean): boolean {
  const [a, c, d] = b
  if (a === 127) return !allowLoopback // loopback
  if (a === 0) return true // "this network", unspecified
  if (a === 10) return true
  if (a === 100 && c >= 64 && c <= 127) return true // CGNAT
  if (a === 169 && c === 254) return true // link-local, cloud metadata
  if (a === 172 && c >= 16 && c <= 31) return true
  if (a === 192 && c === 168) return true
  if (a === 192 && c === 0 && d === 0) return true // IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return true // documentation
  if (a === 198 && (c === 18 || c === 19)) return true // benchmarking
  if (a === 198 && c === 51 && d === 100) return true
  if (a === 203 && c === 0 && d === 113) return true
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/** True when a connection to `ip` must be refused. Anything that does not parse counts as blocked. */
export function isBlockedAddress(ip: string, allowLoopback = false): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return blockedV4(v4, allowLoopback)
  const b = parseIPv6(ip)
  if (!b) return true
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)
  // ::1 loopback, :: unspecified, and the deprecated IPv4-compatible ::a.b.c.d
  if (zeros(0, 12)) {
    if (zeros(12, 15) && b[15] === 1) return !allowLoopback
    return true
  }
  const embedded = b.slice(12, 16)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(embedded, allowLoopback) // IPv4-mapped
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return blockedV4(embedded, allowLoopback) // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6), allowLoopback) // 6to4
  if (b[0] === 0x01 && zeros(1, 8)) return true // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true // documentation
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local
  if (b[0] === 0xff) return true // multicast
  return false
}

// ─── URL vetting ─────────────────────────────────────────────────────────────

export type Resolver = (hostname: string) => Promise<string[]>

export const defaultResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true })).map((r) => r.address)

export interface Vetted {
  url: URL
  ip: string
  family: 4 | 6
}

export interface GuardOptions {
  resolver?: Resolver
  /** Tests only, never read from the environment: allow loopback addresses and any port. */
  allowLoopback?: boolean
}

/** Parse and check the URL, resolve it, and return the one address to connect to. Throws PreviewFetchError. */
export async function vetUrl(raw: string | URL, opts: GuardOptions = {}): Promise<Vetted> {
  let url: URL
  try {
    url = raw instanceof URL ? raw : new URL(raw)
  } catch {
    throw new PreviewFetchError('invalid', 'not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PreviewFetchError('invalid', 'only http and https are allowed')
  if (url.username || url.password) throw new PreviewFetchError('invalid', 'credentials in the URL are not allowed')
  const allowLoopback = opts.allowLoopback === true
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!allowLoopback && port !== 80 && port !== 443) throw new PreviewFetchError('blocked', 'only ports 80 and 443 are allowed')

  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (host === '') throw new PreviewFetchError('invalid', 'no host')
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    // Bare numbers like 2130706433 never get here (the URL parser turns them into
    // dotted IPv4), but a leftover all-numeric label is refused rather than resolved.
    if (/^(0x[0-9a-f]*|\d+)$/i.test(host.split('.').pop() ?? '')) throw new PreviewFetchError('blocked', 'numeric host')
    try {
      addresses = await (opts.resolver ?? defaultResolver)(host)
    } catch {
      throw new PreviewFetchError('network', 'host did not resolve')
    }
  }
  if (addresses.length === 0) throw new PreviewFetchError('network', 'host did not resolve')
  for (const a of addresses) {
    if (isBlockedAddress(a, allowLoopback)) throw new PreviewFetchError('blocked', 'address is not public')
  }
  const ip = addresses[0]
  return { url, ip, family: isIP(ip) === 6 ? 6 : 4 }
}

// ─── Transport ───────────────────────────────────────────────────────────────

export interface TransportRequest {
  url: URL
  /** The vetted address to connect to. Host and TLS server name stay the URL's hostname. */
  ip: string
  family: 4 | 6
  headers: Record<string, string>
  signal: AbortSignal
}

export interface TransportResponse {
  status: number
  /** Lower-case names. */
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  destroy(): void
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const secure = req.url.protocol === 'https:'
    const hostname = req.url.hostname.startsWith('[') ? req.url.hostname.slice(1, -1) : req.url.hostname
    const r = (secure ? https : http).request(
      {
        hostname,
        port: req.url.port || (secure ? 443 : 80),
        path: `${req.url.pathname}${req.url.search}`,
        method: 'GET',
        headers: req.headers,
        agent: false,
        // The pin: whatever the socket asks DNS for, it gets the vetted address.
        lookup: (_host, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as (e: null, a: unknown) => void)(null, [{ address: req.ip, family: req.family }])
          else cb(null, req.ip, req.family)
        },
        ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
      },
      (res) => {
        const headers: Record<string, string | undefined> = {}
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v
        resolve({ status: res.statusCode ?? 0, headers, body: res, destroy: () => res.destroy() })
      },
    )
    r.on('error', reject)
    req.signal.addEventListener('abort', () => r.destroy(new Error('aborted')), { once: true })
    r.end()
  })

// ─── Fetch ───────────────────────────────────────────────────────────────────

export const USER_AGENT = 'nalgorithm-link-preview'
export const MAX_REDIRECTS = 3
export const TOTAL_TIMEOUT_MS = 5000

export interface SafeFetchOptions extends GuardOptions {
  transport?: Transport
  /** Receives the lower-cased media type without parameters. */
  acceptType: (mediaType: string) => boolean
  /** The `Accept` request header. */
  accept: string
  maxBytes: number
  /** When true a body over `maxBytes` is cut there and returned; when false it is an error. */
  truncate: boolean
  timeoutMs?: number
}

export interface SafeFetchResult {
  finalUrl: string
  mediaType: string
  body: Buffer
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PreviewFetchError('timeout', 'timed out'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof PreviewFetchError ? e : new PreviewFetchError('network', 'request failed'))
      },
    )
  })
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const transport = opts.transport ?? nodeTransport
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TOTAL_TIMEOUT_MS)
  const { signal } = controller
  try {
    let current: URL | string = rawUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const vetted = await raceAbort(vetUrl(current, opts), signal)
      // Cookies are never sent, and compression is off so the byte cap is on real bytes.
      const res = await raceAbort(
        transport({
          url: vetted.url,
          ip: vetted.ip,
          family: vetted.family,
          signal,
          headers: { 'User-Agent': USER_AGENT, Accept: opts.accept, 'Accept-Encoding': 'identity' },
        }),
        signal,
      )
      try {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.location
          res.destroy()
          if (!location) throw new PreviewFetchError('status', 'redirect without a location')
          if (hop === MAX_REDIRECTS) throw new PreviewFetchError('redirects', 'too many redirects')
          let next: URL
          try {
            next = new URL(location, vetted.url)
          } catch {
            throw new PreviewFetchError('invalid', 'bad redirect target')
          }
          if (vetted.url.protocol === 'https:' && next.protocol !== 'https:') throw new PreviewFetchError('downgrade', 'redirect from https to http')
          current = next
          continue
        }
        if (res.status < 200 || res.status > 299) throw new PreviewFetchError('status', `status ${res.status}`)
        const mediaType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (!opts.acceptType(mediaType)) throw new PreviewFetchError('type', 'unsupported content type')
        const declared = Number(res.headers['content-length'])
        if (!opts.truncate && Number.isFinite(declared) && declared > opts.maxBytes) throw new PreviewFetchError('size', 'too large')

        const chunks: Buffer[] = []
        let total = 0
        const iterator = res.body[Symbol.asyncIterator]()
        while (true) {
          const next = await raceAbort(iterator.next(), signal)
          if (next.done) break
          const chunk = Buffer.from(next.value)
          if (total + chunk.length > opts.maxBytes) {
            if (!opts.truncate) throw new PreviewFetchError('size', 'too large')
            chunks.push(chunk.subarray(0, opts.maxBytes - total))
            total = opts.maxBytes
            break // stop reading: nothing more is buffered
          }
          chunks.push(chunk)
          total += chunk.length
        }
        return { finalUrl: vetted.url.toString(), mediaType, body: Buffer.concat(chunks) }
      } finally {
        res.destroy()
      }
    }
    throw new PreviewFetchError('redirects', 'too many redirects')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
