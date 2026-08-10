/**
 * Nalgorithm Web — Nostr login (NIP-07 extension, NIP-46 remote signer)
 *
 * Nalgorithm only ever needs to know **who you are** — it reads your follow
 * list, your feed, and your likes. It never publishes and never signs anything.
 * So both login paths here do exactly one thing: obtain your public key.
 *
 * NIP-07  — `window.nostr.getPublicKey()` from a browser extension.
 * NIP-46  — a `nostrconnect://` handshake with a remote signer such as Amber.
 *           We ask for **no permissions at all**, then call `get_public_key`
 *           and immediately close the connection. No signing key material,
 *           and no signing capability, ever reaches this app.
 *
 * On the NIP-46 pubkey specifically: the `pubkey` on the signer's kind-24133
 * response is a per-connection *routing* key, not the user's identity. Newer
 * Amber builds generate a fresh one per connection, so treating it as the npub
 * would silently log you in under an ephemeral key. `get_public_key` is the
 * only correct source, and nostr-tools' `BunkerSigner.getPublicKey()` issues
 * that request rather than returning the routing key.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46'
import { npubEncode } from 'nostr-tools/nip19'

/**
 * Relays used for the NIP-46 handshake. Multiple, because relays go down.
 *
 * Every entry here was verified to actually *round-trip* an ephemeral kind-24133
 * event, publishing on one connection and receiving on another. That check
 * matters: a relay can accept the event and never relay it, which looks exactly
 * like a signer that never answered. `wss://relay.nsec.app` — the dedicated
 * bunker relay, and the obvious first choice — was returning HTTP 502 when this
 * list was set, and `wss://relay.damus.io` would not complete a WebSocket
 * handshake. Re-probe before adding one.
 */
export const DEFAULT_SIGNER_RELAYS = [
  'wss://nostr.cypherpunk.today',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

/** How long to wait for the user to approve in their signer app. */
const APPROVAL_TIMEOUT_MS = 180_000

export interface RemoteSignerSession {
  /** The `nostrconnect://` URI to render as a QR code / deep link. */
  uri: string
  /** Resolves with the user's real hex pubkey once they approve. */
  pubkey: Promise<string>
  /** Abort the pending handshake (user cancelled, dialog closed). */
  cancel: () => void
}

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
    }
  }
}

/** True if a NIP-07 browser extension (Alby, nos2x, ...) is present. */
export function hasNip07(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr?.getPublicKey === 'function'
}

/**
 * Read the pubkey from a NIP-07 extension.
 * This is a read-only call — it does not request signing permission.
 */
export async function loginWithExtension(): Promise<string> {
  if (!hasNip07()) {
    throw new Error('No Nostr extension found. Install Alby or nos2x, or use a remote signer.')
  }
  const pubkey = await window.nostr!.getPublicKey()
  if (!isHexPubkey(pubkey)) {
    throw new Error('Extension returned an invalid public key')
  }
  return pubkey.toLowerCase()
}

/**
 * Begin a NIP-46 remote-signer login.
 *
 * Returns immediately with the URI to display, plus a promise that settles
 * when the signer responds. The caller renders the QR, then awaits `pubkey`.
 */
export function startRemoteSignerLogin(relays: string[] = DEFAULT_SIGNER_RELAYS): RemoteSignerSession {
  const clientSecret = generateSecretKey()
  const clientPubkey = getPublicKey(clientSecret)
  const secret = randomHex(32)

  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    // Deliberately no `perms`: we only call get_public_key. Requesting
    // sign_event or encryption permissions we never use would be asking the
    // user to grant strictly more than this app needs.
    name: 'Nalgorithm',
    url: typeof location !== 'undefined' ? location.origin : undefined,
  })

  const controller = new AbortController()

  // Own the cancellation rather than relying on the library's abort handling:
  // its signal only takes effect once the relay subscription is established,
  // so an early cancel would otherwise leave this promise pending forever.
  const cancelled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error('Signer login cancelled or timed out. Scan the code again to retry.')),
      { once: true }
    )
  })

  const pubkey = (async (): Promise<string> => {
    const timer = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS)
    let signer: BunkerSigner | undefined
    try {
      // Resolves only when the signer returns a response whose result equals
      // our one-time secret exactly. The signal is still passed through so the
      // library tears its subscription down once it can.
      const connecting = BunkerSigner.fromURI(clientSecret, uri, {}, controller.signal)
      // If `cancelled` wins the race the loser still settles later; swallow it
      // so it never surfaces as an unhandled rejection.
      connecting.catch(() => {})
      signer = await Promise.race([connecting, cancelled])

      // The real identity. Not the connection's routing pubkey.
      const userPubkey = await Promise.race([signer.getPublicKey(), cancelled])
      if (!isHexPubkey(userPubkey)) {
        throw new Error('Signer returned an invalid public key')
      }
      return userPubkey.toLowerCase()
    } finally {
      clearTimeout(timer)
      // We are done the moment we know the pubkey — nothing else to ask for.
      try {
        await signer?.close()
      } catch {
        // closing is best-effort
      }
    }
  })()

  // The dialog attaches its own handler; this guarantees the rejection is
  // always observed even if the caller never awaits.
  pubkey.catch(() => {})

  return { uri, pubkey, cancel: () => controller.abort() }
}

/** Format a hex pubkey as an npub for display. Falls back to the hex on error. */
export function toNpub(pubkeyHex: string): string {
  try {
    return npubEncode(pubkeyHex)
  } catch {
    return pubkeyHex
  }
}

function isHexPubkey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}
