/**
 * Relay URLs taken from other people's events are attacker-controlled input.
 * Shared by the library (outbox profile lookups) and the server (DM delivery).
 * No node: imports, so it also bundles for the browser.
 */

const MAX_URL_LENGTH = 200

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function hostIsPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 4 : host.includes(':') ? 6 : 0
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return ipv4Private(a, b)
  }
  if (family === 6) {
    if (host === '::' || host === '::1') return true
    // The URL parser writes v4-mapped addresses as ::ffff:7f00:1.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (mapped) {
      const hi = parseInt(mapped[1], 16)
      return ipv4Private(hi >> 8, hi & 255)
    }
    const first = parseInt(host.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    !host.includes('.')
  )
}

/**
 * Normalise a relay URL taken from someone else's event, or return null if we
 * must not connect to it. Relay lists are attacker-controlled input and the bot
 * opens sockets to whatever they name, so only public wss:// hosts pass.
 * `allowInsecure` exists for tests that talk to a relay on 127.0.0.1.
 */
export function sanitizeRelayUrl(url: unknown, allowInsecure = false): string | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'wss:' && !(allowInsecure && u.protocol === 'ws:')) return null
  if (!allowInsecure && (u.username || u.password || hostIsPrivate(u.hostname))) return null
  u.hash = ''
  const text = u.toString()
  return u.pathname === '/' && !u.search ? text.slice(0, -1) : text
}

export function isAcceptableRelayUrl(url: unknown, allowInsecure = false): boolean {
  return sanitizeRelayUrl(url, allowInsecure) !== null
}
