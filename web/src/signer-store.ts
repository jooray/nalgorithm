/**
 * Nalgorithm Web — the remembered remote signer connection (pure)
 *
 * A NIP-46 connection is a client keypair this app generated plus the signer's
 * routing pubkey and relays. Amber remembers the client key and the
 * permissions the reader granted it, so keeping these three on this device is
 * enough to sign again after a reload without a new QR scan.
 *
 * The client key cannot sign as the reader. It can only ask their signer,
 * which answers within the permissions it was given. No DOM here.
 */

export const SIGNER_KEY = 'nalgorithm_remote_signer'

export interface SavedRemoteSigner {
  v: 1
  /** The reader's hex pubkey (from get_public_key), whom the signer signs for. */
  user: string
  /** This app's NIP-46 client secret key, hex. */
  client: string
  /** The signer's routing pubkey for this connection, hex. */
  remote: string
  relays: string[]
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const HEX64 = /^[0-9a-f]{64}$/

export function parseSavedSigner(raw: string | null): SavedRemoteSigner | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const s = v as Partial<SavedRemoteSigner>
  if (s.v !== 1) return null
  if (typeof s.user !== 'string' || !HEX64.test(s.user)) return null
  if (typeof s.client !== 'string' || !HEX64.test(s.client)) return null
  if (typeof s.remote !== 'string' || !HEX64.test(s.remote)) return null
  if (!Array.isArray(s.relays)) return null
  const relays = s.relays.filter((r): r is string => typeof r === 'string' && /^wss?:\/\//.test(r))
  if (relays.length === 0) return null
  return { v: 1, user: s.user, client: s.client, remote: s.remote, relays }
}

/** The remembered connection, only when it signs for `actor`. */
export function loadSavedSigner(store: KeyValueStore | null, actor: string): SavedRemoteSigner | null {
  if (!store) return null
  try {
    const saved = parseSavedSigner(store.getItem(SIGNER_KEY))
    return saved && saved.user === actor ? saved : null
  } catch {
    return null
  }
}

/** One connection per device: a new one replaces the old. False when storage refused. */
export function saveSavedSigner(store: KeyValueStore | null, saved: SavedRemoteSigner): boolean {
  if (!store) return false
  try {
    store.setItem(SIGNER_KEY, JSON.stringify(saved))
    return true
  } catch {
    return false
  }
}

export function clearSavedSigner(store: KeyValueStore | null): void {
  try {
    store?.removeItem(SIGNER_KEY)
  } catch {
    // nothing stored to clear
  }
}

/** A refusal by the reader keeps the connection; anything else (timeout, revoked, gone) drops it. */
export function keepAfterSignError(message: string): boolean {
  return /reject|denied|declin|cancel/i.test(message)
}
