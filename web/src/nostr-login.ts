/**
 * Nalgorithm Web — Nostr login (NIP-07 extension, NIP-46 remote signer)
 *
 * Bring-your-own-key mode only needs to know **who you are** — it reads your
 * follow list, your feed, and your likes. It never publishes and never signs
 * anything. So in that mode both login paths do exactly one thing: obtain your
 * public key.
 *
 * Hosted mode is the one exception: the server needs proof that you hold the
 * key, so it also asks the signer for a single signature over a login event
 * (kind 27235, never published to a relay). That is opt-in per call
 * (`sign: true`); nothing below changes for the default login.
 *
 * NIP-07  — `window.nostr.getPublicKey()` from a browser extension.
 * NIP-46  — a `nostrconnect://` handshake with a remote signer such as Amber.
 *           By default we ask for **no permissions at all**, then call
 *           `get_public_key` and immediately close the connection. No signing
 *           key material, and no signing capability, ever reaches this app.
 *           With `sign: true` we additionally request `sign_event:27235` and
 *           keep the connection open until the caller has signed and closed.
 *
 * On the NIP-46 pubkey specifically: the `pubkey` on the signer's kind-24133
 * response is a per-connection *routing* key, not the user's identity. Newer
 * Amber builds generate a fresh one per connection, so treating it as the npub
 * would silently log you in under an ephemeral key. `get_public_key` is the
 * only correct source, and nostr-tools' `BunkerSigner.getPublicKey()` issues
 * that request rather than returning the routing key.
 */

import { generateSecretKey, getPublicKey, type EventTemplate, type Event as NostrEvent } from 'nostr-tools/pure'
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46'
import { npubEncode } from 'nostr-tools/nip19'

/**
 * Relays used for the NIP-46 handshake. Multiple, because relays go down.
 *
 * Every entry here was verified to actually *round-trip* an ephemeral kind-24133
 * event, publishing on one connection and receiving on another. That check
 * matters: a relay can accept the event and never relay it, which looks exactly
 * like a signer that never answered.
 *
 * Two obvious candidates failed that probe from two independent networks when
 * this list was set. `wss://relay.nsec.app` — the dedicated bunker relay, and
 * the natural first choice — was returning HTTP 502. `wss://relay.damus.io`
 * would not complete the WebSocket handshake; note it is still perfectly good
 * as a *feed* relay, and remains in the default feed list. Being usable for
 * content says nothing about being usable for the signer handshake, so re-probe
 * rather than assuming.
 */
export const DEFAULT_SIGNER_RELAYS = [
  'wss://nostr.cypherpunk.today',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

/** How long to wait for the user to approve in their signer app. */
const APPROVAL_TIMEOUT_MS = 180_000

/** Signs a login event. Rejects if the signer refuses. */
export type SignFn = (template: EventTemplate) => Promise<NostrEvent>

/** How long to wait for the signer to answer a sign request. */
const SIGN_TIMEOUT_MS = 120_000

/** The kind of the hosted login event (an HTTP auth event, NIP-98 style). */
export const LOGIN_EVENT_KIND = 27235

export interface RemoteSignerSession {
  /** The `nostrconnect://` URI to render as a QR code / deep link. */
  uri: string
  /** Resolves with the user's real hex pubkey once they approve. */
  pubkey: Promise<string>
  /** Abort the pending handshake (user cancelled, dialog closed). */
  cancel: () => void
  /** With `sign: true`: ask the connected signer to sign. Rejects otherwise. */
  sign: SignFn
  /** With `sign: true`: close the signer connection kept open for signing. */
  close: () => void
}

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      /** Only called in hosted mode. */
      signEvent?(event: EventTemplate): Promise<NostrEvent>
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

/** Sign with a NIP-07 extension (hosted mode only). */
export async function signWithExtension(template: EventTemplate): Promise<NostrEvent> {
  if (typeof window.nostr?.signEvent !== 'function') {
    throw new Error('Your Nostr extension cannot sign events.')
  }
  return window.nostr.signEvent(template)
}

export interface RemoteSignerOptions {
  /**
   * Request permission to sign login events and keep the connection open so
   * the caller can use `session.sign`. The caller must then `close()` (or
   * `cancel()`) the session itself.
   */
  sign?: boolean
}

/**
 * Begin a NIP-46 remote-signer login.
 *
 * Returns immediately with the URI to display, plus a promise that settles
 * when the signer responds. The caller renders the QR, then awaits `pubkey`.
 */
export function startRemoteSignerLogin(
  relays: string[] = DEFAULT_SIGNER_RELAYS,
  options: RemoteSignerOptions = {}
): RemoteSignerSession {
  const keepOpen = options.sign === true
  const clientSecret = generateSecretKey()
  const clientPubkey = getPublicKey(clientSecret)
  const secret = randomHex(32)

  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    // No `perms` by default: we only call get_public_key. Requesting
    // sign_event or encryption permissions we never use would be asking the
    // user to grant strictly more than this app needs. Hosted mode is the
    // exception, and asks for exactly one: signing the login event kind.
    ...(keepOpen ? { perms: [`sign_event:${LOGIN_EVENT_KIND}`] } : {}),
    name: 'Nalgorithm',
    url: typeof location !== 'undefined' ? location.origin : undefined,
  })

  const controller = new AbortController()
  // The connected signer, once the handshake completes. Kept for `sign`/`close`.
  let signerRef: BunkerSigner | undefined

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
    let succeeded = false
    try {
      // Resolves only when the signer returns a response whose result equals
      // our one-time secret exactly. The signal is still passed through so the
      // library tears its subscription down once it can.
      const connecting = BunkerSigner.fromURI(clientSecret, uri, {}, controller.signal)
      // If `cancelled` wins the race the loser still settles later; swallow it
      // so it never surfaces as an unhandled rejection.
      connecting.catch(() => {})
      signer = await Promise.race([connecting, cancelled])
      signerRef = signer

      // The real identity. Not the connection's routing pubkey.
      const userPubkey = await Promise.race([signer.getPublicKey(), cancelled])
      if (!isHexPubkey(userPubkey)) {
        throw new Error('Signer returned an invalid public key')
      }
      succeeded = true
      return userPubkey.toLowerCase()
    } finally {
      clearTimeout(timer)
      // We are done the moment we know the pubkey — nothing else to ask for —
      // unless the caller needs the signer for a signature. A failed login
      // always closes it.
      if (!(keepOpen && succeeded)) {
        try {
          await signer?.close()
        } catch {
          // closing is best-effort
        }
      }
    }
  })()

  // The dialog attaches its own handler; this guarantees the rejection is
  // always observed even if the caller never awaits.
  pubkey.catch(() => {})

  const close = (): void => {
    if (!keepOpen) return
    try {
      void signerRef?.close().catch(() => {})
    } catch {
      // closing is best-effort
    }
  }

  const sign: SignFn = async (template) => {
    if (!keepOpen || !signerRef) throw new Error('This login was not set up for signing.')
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The signer did not answer the sign request in time.')), SIGN_TIMEOUT_MS)
    )
    return Promise.race([signerRef.signEvent(template), timeout])
  }

  return {
    uri,
    pubkey,
    cancel: () => {
      controller.abort()
      close()
    },
    sign,
    close,
  }
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
