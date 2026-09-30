import { randomInt } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

export const KIND_SEAL = 13
export const KIND_GIFT_WRAP = 1059
export const KIND_CHAT_MESSAGE = 14
export const KIND_FILE_MESSAGE = 15

/**
 * NIP-44 allows up to 64 KiB of plaintext, which is about 87 KB of base64.
 * Refusing above 64 KiB before any elliptic-curve work bounds what a stranger
 * can make us compute with one event; real messages (at most 4000 characters
 * per part from our own sender) are far below it.
 */
export const MAX_CIPHERTEXT_LENGTH = 64 * 1024

const TWO_DAYS = 2 * 24 * 3600
const HEX64 = /^[0-9a-f]{64}$/

export interface Rumor {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

export type DmRejectReason =
  | 'not_gift_wrap'
  | 'bad_wrap_signature'
  | 'oversized'
  | 'decrypt_failed'
  | 'malformed_seal'
  | 'bad_seal_kind'
  | 'seal_has_tags'
  | 'bad_seal_signature'
  | 'malformed_rumor'
  | 'pubkey_mismatch'
  | 'rumor_id_mismatch'
  | 'unsupported_kind'

/** A gift wrap that must be dropped. `reason` is stable and machine-readable; retrying never helps. */
export class DmRejectedError extends Error {
  constructor(
    readonly reason: DmRejectReason,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'DmRejectedError'
  }
}

export interface WrapOptions {
  /** Unix seconds; default is the wall clock. */
  now?: number
  /** Uniform integer in [0, max); default is crypto.randomInt. */
  random?: (max: number) => number
}

/** Seconds in the past, 0 to 2 days. Never in the future: some relays reject skew above 300 s. */
function pastTimestamp(now: number, random: (max: number) => number): number {
  return now - random(TWO_DAYS + 1)
}

/** Unsigned kind 14 event with its id. Built once per message so every wrap of it shares the id. */
export function buildRumor(senderPubkey: string, recipientPubkey: string, text: string, now = Math.floor(Date.now() / 1000)): Rumor {
  const draft = { pubkey: senderPubkey, created_at: now, kind: KIND_CHAT_MESSAGE, tags: [['p', recipientPubkey]], content: text }
  return { ...draft, id: getEventHash(draft) }
}

/**
 * Seal a rumor with the sender's key and gift-wrap it to `wrapTo` with a fresh
 * one-time key. Seal and wrap timestamps are drawn independently so neither
 * reveals the real send time.
 */
export function wrapRumor(secretKey: Uint8Array, rumor: Rumor, wrapTo: string, opts: WrapOptions = {}): Event {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const random = opts.random ?? ((max: number) => randomInt(max))
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: pastTimestamp(now, random),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(secretKey, wrapTo)),
    },
    secretKey,
  )
  const oneTime = generateSecretKey()
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: pastTimestamp(now, random),
      tags: [['p', wrapTo]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(oneTime, wrapTo)),
    },
    oneTime,
  )
}

/** Build the rumor for `text` and wrap it to the recipient. Pass `opts.rumor` to reuse an existing one. */
export function wrapForRecipient(
  secretKey: Uint8Array,
  recipientPubkey: string,
  text: string,
  opts: WrapOptions & { rumor?: Rumor } = {},
): { wrap: Event; rumor: Rumor } {
  const rumor = opts.rumor ?? buildRumor(getPublicKey(secretKey), recipientPubkey, text, opts.now)
  return { wrap: wrapRumor(secretKey, rumor, recipientPubkey, opts), rumor }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJson(text: string, reason: DmRejectReason): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new DmRejectedError(reason, 'not JSON')
  }
}

function decryptLayer(content: unknown, secretKey: Uint8Array, peer: string, malformed: DmRejectReason): unknown {
  if (typeof content !== 'string') throw new DmRejectedError('decrypt_failed', 'content is not a string')
  if (content.length > MAX_CIPHERTEXT_LENGTH) throw new DmRejectedError('oversized', `${content.length} bytes`)
  let plain: string
  try {
    plain = nip44.decrypt(content, nip44.getConversationKey(secretKey, peer))
  } catch (err) {
    throw new DmRejectedError('decrypt_failed', (err as Error).message)
  }
  return parseJson(plain, malformed)
}

function checkedEvent(value: unknown, reason: DmRejectReason): Event {
  if (!isRecord(value) || typeof value.pubkey !== 'string' || !HEX64.test(value.pubkey) || !Array.isArray(value.tags)) {
    throw new DmRejectedError(reason)
  }
  return value as unknown as Event
}

function checkedRumor(value: unknown): Rumor {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !HEX64.test(value.id) ||
    typeof value.pubkey !== 'string' ||
    !HEX64.test(value.pubkey) ||
    !Number.isSafeInteger(value.created_at) ||
    (value.created_at as number) < 0 ||
    !Number.isSafeInteger(value.kind) ||
    typeof value.content !== 'string' ||
    !Array.isArray(value.tags) ||
    !value.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))
  ) {
    throw new DmRejectedError('malformed_rumor')
  }
  const { id, pubkey, created_at, kind, tags, content } = value as unknown as Rumor
  return { id, pubkey, created_at, kind, tags, content }
}

function validSignature(event: Event): boolean {
  try {
    // verifyEvent remembers a positive result on the object itself; check a
    // plain copy so a flag carried in on the input can never stand in for the check.
    const { id, pubkey, created_at, kind, tags, content, sig } = event
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  } catch {
    return false
  }
}

/**
 * Open a gift wrap addressed to the bot and return the message with its
 * verified author. nostr-tools' own unwrap skips the seal signature and the
 * seal/rumor author comparison, which lets anyone claim any sender, so every
 * layer is checked here. `senderPubkey` (the seal signer, proven to equal the
 * rumor author) is the only identity callers may act on.
 */
export function unwrapGiftWrap(wrap: Event, botSecretKey: Uint8Array): { rumor: Rumor; senderPubkey: string; seal: Event } {
  if (!isRecord(wrap) || wrap.kind !== KIND_GIFT_WRAP) throw new DmRejectedError('not_gift_wrap')
  if (typeof wrap.content === 'string' && wrap.content.length > MAX_CIPHERTEXT_LENGTH) {
    throw new DmRejectedError('oversized', `${wrap.content.length} bytes`)
  }
  if (!validSignature(wrap)) throw new DmRejectedError('bad_wrap_signature')

  const seal = checkedEvent(decryptLayer(wrap.content, botSecretKey, wrap.pubkey, 'malformed_seal'), 'malformed_seal')
  if (seal.kind !== KIND_SEAL) throw new DmRejectedError('bad_seal_kind', String(seal.kind))
  if (seal.tags.length !== 0) throw new DmRejectedError('seal_has_tags')
  if (!validSignature(seal)) throw new DmRejectedError('bad_seal_signature')

  const rumor = checkedRumor(decryptLayer(seal.content, botSecretKey, seal.pubkey, 'malformed_rumor'))
  if (rumor.pubkey !== seal.pubkey) throw new DmRejectedError('pubkey_mismatch')
  if (getEventHash(rumor) !== rumor.id) throw new DmRejectedError('rumor_id_mismatch')
  if (rumor.kind !== KIND_CHAT_MESSAGE) throw new DmRejectedError('unsupported_kind', String(rumor.kind))
  return { rumor, senderPubkey: seal.pubkey, seal }
}
