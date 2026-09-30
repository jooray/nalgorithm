import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { AbstractSimplePool } from 'nostr-tools/pool'
import * as nip04 from 'nostr-tools/nip04'
import { publishToRelays, type PublishOptions } from './publish.js'
import type { RelayResolver, RelayTier } from './relays.js'
import { buildRumor, wrapRumor, type WrapOptions } from './wrap.js'
import { silentLogger, type DmLogger, type DmProtocol, type RelayOutcome } from './types.js'

export const MAX_TEXT_LENGTH = 8000
export const MAX_PART_LENGTH = 4000
const KIND_NIP04 = 4
const HEX64 = /^[0-9a-f]{64}$/

export type DmSendErrorReason = 'bad_recipient' | 'empty' | 'too_long'

/** The request itself is unsendable; nothing was published. */
export class DmSendError extends Error {
  constructor(
    readonly reason: DmSendErrorReason,
    message: string,
  ) {
    super(message)
    this.name = 'DmSendError'
  }
}

export interface DmSendOptions {
  format?: DmProtocol
  /** Relays where this peer's messages were seen arriving; appended to the resolved targets. */
  extraRelays?: string[]
}

export interface DmSendResult {
  /** The recipient's copy was accepted by at least one relay. */
  delivered: boolean
  protocol: DmProtocol
  tier: RelayTier
  /** Id of the event published to the recipient's relays (the gift wrap for NIP-17). */
  eventId: string
  /** Same for every wrap of one message; the event id for NIP-04. */
  rumorId: string
  relays: Record<string, RelayOutcome>
  /** NIP-17 only. A failed self-copy never fails the send. */
  selfCopy?: { delivered: boolean; eventId: string; relays: Record<string, RelayOutcome> }
}

export interface DmSender {
  /**
   * One result per part, in send order. Text over 4000 characters goes out as
   * several messages split at paragraph boundaries; if a part is not delivered
   * the remaining parts are not sent, so the peer never sees a gap.
   * Throws DmSendError for a bad recipient, empty text or text over 8000 characters.
   */
  send(recipientPubkey: string, text: string, opts?: DmSendOptions): Promise<DmSendResult[]>
}

export interface DmSenderOptions {
  pool: Pick<AbstractSimplePool, 'ensureRelay'>
  resolver: RelayResolver
  secretKey: Uint8Array
  /** The bot's own inbox relays, where the self-copy goes. */
  selfRelays: string[]
  log?: DmLogger
  publish?: PublishOptions
  wrap?: WrapOptions
}

/** Cut at the last boundary that keeps a part under `max`: blank line, line, space, then hard. */
function cutPoint(text: string, max: number): number {
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, max)
    if (at > max / 4) return at + sep.length
  }
  // Do not split a surrogate pair.
  const code = text.charCodeAt(max - 1)
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max
}

export function splitMessage(text: string, max = MAX_PART_LENGTH): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const at = cutPoint(rest, max)
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

export function createDmSender(opts: DmSenderOptions): DmSender {
  const { pool, resolver, secretKey, selfRelays } = opts
  const log = opts.log ?? silentLogger
  const botPubkey = getPublicKey(secretKey)

  async function sendPart(recipient: string, text: string, format: DmProtocol, extraRelays: string[], createdAt: number): Promise<DmSendResult> {
    const { relays, tier } = await resolver.resolve(recipient, extraRelays)

    if (format === 'nip04') {
      // Legacy path: a single kind 4 event. It is authored by the bot, so relays
      // keep it as sent history and no separate self-copy is needed.
      const event = finalizeEvent(
        {
          kind: KIND_NIP04,
          created_at: createdAt,
          tags: [['p', recipient]],
          content: nip04.encrypt(secretKey, recipient, text),
        },
        secretKey,
      )
      const res = await publishToRelays(pool, event, relays, opts.publish)
      return { delivered: res.delivered, protocol: 'nip04', tier, eventId: event.id, rumorId: event.id, relays: res.relays }
    }

    // One rumor, two wraps: the recipient's copy and ours share the rumor id.
    const rumor = buildRumor(botPubkey, recipient, text, createdAt)
    const toRecipient = wrapRumor(secretKey, rumor, recipient, opts.wrap)
    const toSelf = wrapRumor(secretKey, rumor, botPubkey, opts.wrap)
    const [res, self] = await Promise.all([
      publishToRelays(pool, toRecipient, relays, opts.publish),
      publishToRelays(pool, toSelf, selfRelays, opts.publish).catch((err: Error) => {
        log.warn(`dm self-copy failed: ${err.message}`)
        return null
      }),
    ])
    if (self && !self.delivered) log.warn('dm self-copy not accepted by any relay')
    return {
      delivered: res.delivered,
      protocol: 'nip17',
      tier,
      eventId: toRecipient.id,
      rumorId: rumor.id,
      relays: res.relays,
      selfCopy: self ? { delivered: self.delivered, eventId: toSelf.id, relays: self.relays } : undefined,
    }
  }

  return {
    async send(recipientPubkey, text, sendOpts = {}) {
      if (!HEX64.test(recipientPubkey)) throw new DmSendError('bad_recipient', 'recipient must be a 64-character lowercase hex pubkey')
      if (!text.trim()) throw new DmSendError('empty', 'message is empty')
      if (text.length > MAX_TEXT_LENGTH) throw new DmSendError('too_long', `message is ${text.length} characters, limit ${MAX_TEXT_LENGTH}`)
      const format = sendOpts.format ?? 'nip17'
      const results: DmSendResult[] = []
      // Clients order by the second-resolution rumor time, so consecutive parts
      // get strictly increasing times even when they go out within one second.
      let createdAt = 0
      for (const part of splitMessage(text)) {
        createdAt = Math.max(opts.wrap?.now ?? Math.floor(Date.now() / 1000), createdAt + 1)
        const result = await sendPart(recipientPubkey, part, format, sendOpts.extraRelays ?? [], createdAt)
        results.push(result)
        if (!result.delivered) {
          log.warn(`dm not delivered (${format}, tier ${result.tier}); ${results.length} part(s) attempted`)
          break
        }
      }
      return results
    },
  }
}
