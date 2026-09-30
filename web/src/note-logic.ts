/**
 * Nalgorithm Web — note actions, pure logic
 *
 * Everything that decides what an event looks like or whether a reply from a
 * stranger's server can be trusted lives here, with no DOM and no network, so
 * it can be tested. Covers:
 *
 *  - NIP-10 reply tags, NIP-25 reactions, NIP-18 reposts
 *  - NIP-65 relay lists and where an event is published
 *  - NIP-57 zaps: zap request, LNURL-pay parameters, bolt11 amount and
 *    description hash, and the receipt
 *
 * Rule for zaps: every field that comes from an LNURL server or from a relay
 * is untrusted input and is checked before it reaches the screen or a wallet.
 */

import * as nip10 from 'nostr-tools/nip10'

// ─── Types ───────────────────────────────────────────────────────────────────

/** The fields of a Nostr event this file reads (a full event satisfies it). */
export interface EventLike {
  id: string
  pubkey: string
  kind: number
  created_at: number
  content: string
  tags: string[][]
  sig?: string
}

export interface UnsignedEvent {
  kind: number
  created_at: number
  content: string
  tags: string[][]
}

/** What an action needs to know about the note it targets. */
export interface Target {
  id: string
  author: string
  /** Event kind; 1 when unknown (the feed only ranks text notes). */
  kind: number
  /** A relay the note was seen on. */
  relay?: string
}

const HEX_64 = /^[0-9a-f]{64}$/

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value)
}

// ─── Relays (NIP-65) ─────────────────────────────────────────────────────────

/** A clean wss:// URL, or '' when the input cannot be used. ws:// is kept only for localhost. */
export function normalizeRelay(input: string): string {
  const raw = input.trim()
  if (!raw || raw.length > 200) return ''
  try {
    const url = new URL(raw)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) return ''
    if (url.username || url.password) return ''
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.protocol}//${url.host}${path}${url.search}`
  } catch {
    return ''
  }
}

export interface RelayList {
  read: string[]
  write: string[]
}

/** Read and write relays from a kind 10002 event. An `r` tag without a marker is both. */
export function parseRelayList(event: Pick<EventLike, 'tags'>): RelayList {
  const read: string[] = []
  const write: string[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue
    const url = normalizeRelay(tag[1])
    if (!url) continue
    const marker = tag[2]
    if (marker === 'read') read.push(url)
    else if (marker === 'write') write.push(url)
    else {
      read.push(url)
      write.push(url)
    }
  }
  return { read: [...new Set(read)], write: [...new Set(write)] }
}

export interface PublishPlan {
  relays: string[]
}

const MAX_OWN_RELAYS = 8
const MAX_PARENT_RELAYS = 3

/**
 * Where to publish: the writer's own write relays (or the configured defaults
 * when their list is unknown), plus a few of the parent author's read relays
 * so the reply reaches them.
 */
export function selectPublishRelays(input: {
  ownWrite?: string[]
  defaults: string[]
  parentRead?: string[]
}): string[] {
  const clean = (list: string[] | undefined): string[] =>
    [...new Set((list ?? []).map(normalizeRelay).filter(Boolean))]
  let own = clean(input.ownWrite)
  if (own.length === 0) own = clean(input.defaults)
  const out = own.slice(0, MAX_OWN_RELAYS)
  for (const r of clean(input.parentRead).slice(0, MAX_PARENT_RELAYS)) {
    if (!out.includes(r)) out.push(r)
  }
  return out
}

export interface RelayResult {
  relay: string
  ok: boolean
  /** Why it failed, from the relay or the connection. */
  error?: string
}

/** "Published to 3 of 5 relays", honest about zero and about partial success. */
export function describePublish(results: RelayResult[]): string {
  const total = results.length
  const ok = results.filter((r) => r.ok).length
  if (total === 0) return 'No relays to publish to'
  if (ok === 0) return `No relay accepted it (0 of ${total})`
  return `Published to ${ok} of ${total} ${total === 1 ? 'relay' : 'relays'}`
}

// ─── Templates: like, boost, reply ───────────────────────────────────────────

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** NIP-25 reaction: kind 7, content "+". */
export function likeTemplate(target: Target, created = nowSeconds()): UnsignedEvent {
  const tags: string[][] = [['e', target.id, target.relay ?? '', target.author]]
  tags.push(['p', target.author, ''])
  tags.push(['k', String(target.kind)])
  return { kind: 7, created_at: created, content: '+', tags }
}

/**
 * NIP-18 repost. A kind 1 note is boosted with kind 6, anything else with the
 * generic repost, kind 16, which also carries a `k` tag. The content is the
 * JSON of the original when we have it and empty when we do not (allowed).
 */
export function repostTemplate(target: Target, original?: EventLike, created = nowSeconds()): UnsignedEvent {
  const isNote = target.kind === 1
  const tags: string[][] = [
    ['e', target.id, target.relay ?? ''],
    ['p', target.author],
  ]
  if (!isNote) tags.push(['k', String(target.kind)])
  return {
    kind: isNote ? 6 : 16,
    created_at: created,
    content: original && original.id === target.id ? JSON.stringify(original) : '',
    tags,
  }
}

/** The NIP-10 thread position of an event: its root, its direct parent and the people in it. */
export interface Thread {
  rootId?: string
  rootRelay?: string
  rootAuthor?: string
  parentId?: string
}

/** The direct parent of an event per NIP-10 (marked or positional), or undefined for a top-level note. */
export function parentOf(event: Pick<EventLike, 'tags'>): { id: string; relay?: string; author?: string } | undefined {
  const refs = nip10.parse(event)
  const ref = refs.reply ?? refs.root
  if (!ref || !isHex64(ref.id)) return undefined
  return { id: ref.id, relay: ref.relays?.[0], author: ref.author }
}

const MAX_P_TAGS = 20

/**
 * Tags for a reply to `parent`, per NIP-10 with markers.
 *
 *  - Parent is top-level: one `e` tag, marked root.
 *  - Parent is itself a reply: the parent's root, marked root, then the parent,
 *    marked reply.
 *  - `p` tags: the parent's author first, then everyone the parent tagged,
 *    deduplicated, never yourself, at most 20.
 */
export function replyTags(
  parent: Pick<EventLike, 'id' | 'pubkey' | 'tags'>,
  options: { relay?: string; self?: string } = {}
): string[][] {
  const refs = nip10.parse(parent)
  const relay = options.relay ?? ''
  const tags: string[][] = []

  const root = refs.root && isHex64(refs.root.id) ? refs.root : undefined
  if (root && root.id !== parent.id) {
    const rootRelay = root.relays?.[0] ?? ''
    tags.push(root.author ? ['e', root.id, rootRelay, 'root', root.author] : ['e', root.id, rootRelay, 'root'])
    tags.push(['e', parent.id, relay, 'reply', parent.pubkey])
  } else {
    tags.push(['e', parent.id, relay, 'root', parent.pubkey])
  }

  const people: string[] = [parent.pubkey]
  for (const tag of parent.tags) {
    if (tag[0] === 'p' && isHex64(tag[1])) people.push(tag[1])
  }
  const seen = new Set<string>()
  for (const pk of people) {
    if (seen.has(pk) || pk === options.self) continue
    seen.add(pk)
    if (seen.size > MAX_P_TAGS) break
    tags.push(['p', pk])
  }
  return tags
}

export function replyTemplate(
  content: string,
  parent: Pick<EventLike, 'id' | 'pubkey' | 'tags'>,
  options: { relay?: string; self?: string; created?: number } = {}
): UnsignedEvent {
  return {
    kind: 1,
    created_at: options.created ?? nowSeconds(),
    content: content.trim(),
    tags: replyTags(parent, options),
  }
}

/** Direct replies to `targetId`, oldest first, at most `limit`. Events that only mention it are dropped. */
export function directReplies<T extends EventLike>(events: T[], targetId: string, limit = 20): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of events) {
    if (e.kind !== 1 || seen.has(e.id)) continue
    seen.add(e.id)
    if (parentOf(e)?.id === targetId) out.push(e)
  }
  out.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
  return out.slice(0, limit)
}

// ─── bech32 (lnurl and bolt11) ───────────────────────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

/** Decode a bech32 string (not bech32m) of any length. Null if malformed or the checksum fails. */
export function bech32Decode(input: string): { hrp: string; words: number[] } | null {
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) return null
  const s = input.toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 1 || sep + 7 > s.length) return null
  const hrp = s.slice(0, sep)
  const data: number[] = []
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch)
    if (v < 0) return null
    data.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null
  return { hrp, words: data.slice(0, -6) }
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v < 0 || v >> from !== 0) return null
    acc = (acc << from) | v
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & max)
    }
    acc &= (1 << bits) - 1
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max)
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    return null
  }
  return out
}

export function bech32Encode(hrp: string, bytes: ArrayLike<number>): string {
  return bech32EncodeWords(hrp, convertBits(bytes, 8, 5, true) ?? [])
}

export function bech32EncodeWords(hrp: string, words: number[]): string {
  const check = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((check >>> (5 * (5 - i))) & 31)
  return hrp + '1' + [...words, ...checksum].map((w) => CHARSET[w]).join('')
}

// ─── LNURL (LUD-01, LUD-06, LUD-16) ──────────────────────────────────────────

/** The bech32 `lnurl1…` form of a URL (what the zap request's `lnurl` tag carries). */
export function lnurlEncode(url: string): string {
  return bech32Encode('lnurl', new TextEncoder().encode(url))
}

/** The URL inside an `lnurl1…` string, or null. Only https is accepted. */
export function lnurlDecode(lnurl: string): string | null {
  const dec = bech32Decode(lnurl.trim().replace(/^lightning:/i, ''))
  if (!dec || dec.hrp !== 'lnurl') return null
  const bytes = convertBits(dec.words, 5, 8, false)
  if (!bytes) return null
  try {
    const url = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
    return isHttpsUrl(url) ? url : null
  } catch {
    return null
  }
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.')
  } catch {
    return false
  }
}

const LN_ADDRESS = /^([a-z0-9._+-]{1,64})@((?:[a-z0-9-]+\.)+[a-z]{2,})$/i

/** A well-formed Lightning address, lower-cased, or null. */
export function parseLightningAddress(input: string): string | null {
  const s = input.trim().replace(/^lightning:/i, '')
  return LN_ADDRESS.test(s) ? s.toLowerCase() : null
}

/** The LNURL-pay endpoint of a Lightning address. */
export function lightningAddressUrl(address: string): string | null {
  const parsed = parseLightningAddress(address)
  if (!parsed) return null
  const [name, domain] = parsed.split('@')
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`
}

export interface PayTarget {
  /** Shown to the reader. */
  label: string
  /** The LNURL-pay endpoint. */
  url: string
  /** The bech32 form for the zap request. */
  lnurl: string
  /** The address to copy as a fallback, when there is one. */
  address?: string
}

/** Where to pay an author, from their kind 0 metadata: lud16 first, then lud06. Null when neither is usable. */
export function payTargetFromProfile(meta: { lud16?: unknown; lud06?: unknown }): PayTarget | null {
  if (typeof meta.lud16 === 'string') {
    const address = parseLightningAddress(meta.lud16)
    const url = address ? lightningAddressUrl(address) : null
    if (address && url) return { label: address, url, lnurl: lnurlEncode(url), address }
  }
  if (typeof meta.lud06 === 'string') {
    const url = lnurlDecode(meta.lud06)
    if (url) return { label: new URL(url).hostname, url, lnurl: meta.lud06.trim().replace(/^lightning:/i, '').toLowerCase() }
  }
  return null
}

export interface PayParams {
  callback: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
  nostrPubkey: string
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/**
 * Validate an LNURL-pay response for a zap. Untrusted input: the callback must
 * be https, the sendable range must be sane, and the server must declare
 * `allowsNostr` with a valid `nostrPubkey`, otherwise no receipt can ever be
 * verified and the payment would not be a zap.
 */
export function parsePayParams(json: unknown): Checked<PayParams> {
  if (!json || typeof json !== 'object') return fail('The Lightning server sent something unexpected.')
  const j = json as Record<string, unknown>
  if (j.status === 'ERROR') return fail('The Lightning server refused the request.')
  if (j.tag !== 'payRequest') return fail('That address is not a Lightning payment endpoint.')
  if (!isHttpsUrl(j.callback)) return fail('The server gave an unsafe payment callback (not https), so I did not use it.')
  const min = Number(j.minSendable)
  const max = Number(j.maxSendable)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
    return fail('The server gave an invalid amount range.')
  }
  if (j.allowsNostr !== true) return fail('That Lightning address does not support zaps (it does not declare Nostr support).')
  if (!isHex64(j.nostrPubkey)) return fail('The server did not give a valid key for zap receipts, so a zap cannot be verified.')
  const comment = Number(j.commentAllowed)
  return {
    ok: true,
    value: {
      callback: j.callback,
      minSendable: min,
      maxSendable: max,
      commentAllowed: Number.isFinite(comment) && comment > 0 ? Math.floor(comment) : 0,
      nostrPubkey: j.nostrPubkey,
    },
  }
}

/** Check an amount (in sats) against the server's range, in whole sats for display. */
export function checkAmount(params: Pick<PayParams, 'minSendable' | 'maxSendable'>, sats: number): Checked<number> {
  if (!Number.isInteger(sats) || sats < 1) return fail('Enter a whole number of sats.')
  const msats = sats * 1000
  const minSats = Math.ceil(params.minSendable / 1000)
  const maxSats = Math.floor(params.maxSendable / 1000)
  if (msats < params.minSendable) return fail(`The smallest zap this address accepts is ${minSats.toLocaleString('en')} sats.`)
  if (msats > params.maxSendable) return fail(`The largest zap this address accepts is ${maxSats.toLocaleString('en')} sats.`)
  return { ok: true, value: msats }
}

/** The callback request URL: amount, the signed zap request and the lnurl, plus the comment when the server allows one. */
export function buildInvoiceUrl(
  params: Pick<PayParams, 'callback' | 'commentAllowed'>,
  input: { msats: number; zapRequestJson: string; lnurl: string; comment?: string }
): string {
  const url = new URL(params.callback)
  url.searchParams.set('amount', String(input.msats))
  url.searchParams.set('nostr', input.zapRequestJson)
  url.searchParams.set('lnurl', input.lnurl)
  const comment = (input.comment ?? '').trim()
  if (comment && params.commentAllowed > 0) url.searchParams.set('comment', comment.slice(0, params.commentAllowed))
  return url.toString()
}

// ─── Zap request (kind 9734) ─────────────────────────────────────────────────

export interface ZapRequestInput {
  recipient: string
  /** The note being zapped. */
  eventId?: string
  eventKind?: number
  msats: number
  relays: string[]
  lnurl: string
  comment?: string
  created?: number
}

/** The unsigned NIP-57 zap request. It is sent to the LNURL server, never published to a relay. */
export function zapRequestTemplate(input: ZapRequestInput): UnsignedEvent {
  const tags: string[][] = [
    ['relays', ...input.relays],
    ['amount', String(input.msats)],
    ['lnurl', input.lnurl],
    ['p', input.recipient],
  ]
  if (input.eventId) tags.push(['e', input.eventId])
  if (input.eventId && input.eventKind !== undefined) tags.push(['k', String(input.eventKind)])
  return { kind: 9734, created_at: input.created ?? nowSeconds(), content: (input.comment ?? '').trim(), tags }
}

// ─── bolt11 ──────────────────────────────────────────────────────────────────

/** The amount of a bolt11 invoice in millisatoshis, or null when it has none or is malformed. */
export function parseBolt11Amount(invoice: string): bigint | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  const sep = s.lastIndexOf('1')
  if (sep < 4) return null
  const m = /^ln(?:bcrt|bc|tbs|tb)(\d*)([munp]?)$/.exec(s.slice(0, sep))
  if (!m || m[1] === '') return null
  if (m[1].length > 1 && m[1].startsWith('0')) return null
  const n = BigInt(m[1])
  // 1 BTC = 100,000,000,000 msat
  const unit = { '': 1n, m: 1000n, u: 1000000n, n: 1000000000n, p: 1000000000000n }[m[2] as '' | 'm' | 'u' | 'n' | 'p']
  const scaled = n * 100000000000n
  if (m[2] === 'p' && n % 10n !== 0n) return null // sub-millisatoshi
  return scaled / unit
}

export interface DecodedInvoice {
  amountMsats: bigint | null
  /** Hex of the `h` tag (description hash), when present. */
  descriptionHash?: string
  /** The `d` tag text, when present. */
  description?: string
  /** Unix seconds the invoice was made. */
  timestamp: number
  /** Seconds it is valid for (3600 when not stated). */
  expiry: number
}

function wordsToBytes(words: number[]): number[] {
  return convertBits(words, 5, 8, false) ?? convertBits(words, 5, 8, true) ?? []
}

const toHex = (bytes: ArrayLike<number>): string => Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join('')

/** Decode the parts of a bolt11 invoice a zap needs. Null if it is not a valid invoice (checksum included). */
export function decodeBolt11(invoice: string): DecodedInvoice | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  const dec = bech32Decode(s)
  if (!dec || !/^ln(?:bcrt|bc|tbs|tb)/.test(dec.hrp)) return null
  const amountMsats = parseBolt11Amount(s)
  const words = dec.words
  // timestamp (7 words) ... tagged fields ... signature (104 words)
  if (words.length < 7 + 104) return null
  let timestamp = 0
  for (const w of words.slice(0, 7)) timestamp = timestamp * 32 + w
  const fields = words.slice(7, words.length - 104)
  const out: DecodedInvoice = { amountMsats, timestamp, expiry: 3600 }
  let i = 0
  while (i + 3 <= fields.length) {
    const type = fields[i]
    const len = fields[i + 1] * 32 + fields[i + 2]
    const data = fields.slice(i + 3, i + 3 + len)
    if (data.length !== len) return null
    i += 3 + len
    if (type === 23 && len === 52) out.descriptionHash = toHex(wordsToBytes(data).slice(0, 32))
    else if (type === 13) {
      try {
        out.description = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(wordsToBytes(data)))
      } catch {
        // a description that is not UTF-8 cannot be matched; leave it unset
      }
    } else if (type === 6) {
      let e = 0
      for (const w of data) e = e * 32 + w
      out.expiry = e
    }
  }
  return out
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

/**
 * Check the invoice the LNURL server returned against the zap request we
 * signed: the amount is exactly what was asked, and the invoice commits to our
 * zap request by its description hash (an `h` tag, or a `d` tag we can hash).
 */
export async function validateInvoice(
  invoice: unknown,
  expected: { msats: number; zapRequestJson: string }
): Promise<Checked<DecodedInvoice>> {
  if (typeof invoice !== 'string' || invoice.length > 4000) return fail('The server did not return an invoice.')
  const decoded = decodeBolt11(invoice)
  if (!decoded) return fail('The invoice from the server is not a valid Lightning invoice.')
  if (decoded.amountMsats === null) return fail('The invoice has no amount, so I did not use it.')
  if (decoded.amountMsats !== BigInt(expected.msats)) {
    const asked = expected.msats / 1000
    const got = Number(decoded.amountMsats) / 1000
    return fail(`The invoice is for ${got.toLocaleString('en')} sats, not the ${asked.toLocaleString('en')} you chose, so I did not use it.`)
  }
  const want = await sha256Hex(expected.zapRequestJson)
  const have = decoded.descriptionHash ?? (decoded.description !== undefined ? await sha256Hex(decoded.description) : undefined)
  if (have === undefined) return fail('The invoice does not commit to the zap request, so it would not produce a zap receipt.')
  if (have !== want) return fail('The invoice does not match the zap request I signed, so I did not use it.')
  return { ok: true, value: decoded }
}

// ─── Zap receipt (kind 9735) ─────────────────────────────────────────────────

export interface ReceiptExpectation {
  /** The zap request we signed (full event). */
  zapRequest: EventLike
  /** The JSON we sent, the exact string whose hash the invoice commits to. */
  zapRequestJson: string
  /** `nostrPubkey` from the LNURL server. */
  nostrPubkey: string
  /** The invoice we were given. */
  invoice: string
}

/**
 * Is this event the receipt for our zap? Checks, in order: kind, that it was
 * signed by the server's declared `nostrPubkey`, that its `bolt11` is the
 * invoice we were handed (so amount matches too), that its `description` is
 * our zap request, and that the invoice's description hash is the hash of it.
 * Signature validity is checked by the caller (verifyEvent).
 */
export async function validateReceipt(receipt: EventLike, expected: ReceiptExpectation): Promise<Checked<{ msats: number }>> {
  if (receipt.kind !== 9735) return fail('Not a zap receipt.')
  if (receipt.pubkey !== expected.nostrPubkey) return fail('The receipt is not signed by the Lightning server that issued the invoice.')
  const tag = (name: string): string | undefined => receipt.tags.find((t) => t[0] === name)?.[1]

  const bolt11 = tag('bolt11')
  if (!bolt11 || bolt11.toLowerCase() !== expected.invoice.trim().toLowerCase()) return fail('The receipt is for a different invoice.')

  const description = tag('description')
  if (!description) return fail('The receipt has no description.')
  let embedded: EventLike
  try {
    embedded = JSON.parse(description) as EventLike
  } catch {
    return fail('The receipt description is not a zap request.')
  }
  if (embedded.id !== expected.zapRequest.id || embedded.pubkey !== expected.zapRequest.pubkey) {
    return fail('The receipt is for a different zap request.')
  }
  if (description !== expected.zapRequestJson && JSON.stringify(embedded) !== expected.zapRequestJson) {
    return fail('The receipt description does not match the zap request.')
  }

  const decoded = decodeBolt11(bolt11)
  if (!decoded || decoded.amountMsats === null) return fail('The receipt invoice is not valid.')
  const requested = Number(expected.zapRequest.tags.find((t) => t[0] === 'amount')?.[1])
  if (!Number.isFinite(requested) || decoded.amountMsats !== BigInt(requested)) return fail('The receipt amount is not what was requested.')
  const hash = decoded.descriptionHash ?? (decoded.description !== undefined ? await sha256Hex(decoded.description) : undefined)
  if (hash !== (await sha256Hex(description)) && hash !== (await sha256Hex(expected.zapRequestJson))) {
    return fail('The receipt invoice does not commit to the zap request.')
  }
  return { ok: true, value: { msats: requested } }
}

// ─── Local note state (liked, boosted, zapped) ───────────────────────────────

export interface NoteState {
  liked: Record<string, number>
  boosted: Record<string, number>
  /** Sats zapped, per note id. */
  zapped: Record<string, number>
}

export const EMPTY_STATE: NoteState = { liked: {}, boosted: {}, zapped: {} }

const STATE_LIMIT = 3000

/** Parse what was stored, dropping anything that is not the expected shape. */
export function parseNoteState(raw: string | null): NoteState {
  const state: NoteState = { liked: {}, boosted: {}, zapped: {} }
  if (!raw) return state
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof NoteState, Record<string, unknown>>>
    for (const key of ['liked', 'boosted', 'zapped'] as const) {
      const src = parsed?.[key]
      if (!src || typeof src !== 'object') continue
      for (const [id, value] of Object.entries(src)) {
        if (isHex64(id) && typeof value === 'number' && Number.isFinite(value)) state[key][id] = value
      }
    }
  } catch {
    // unreadable: start clean
  }
  return state
}

/** Keep the newest entries of each map when a state grows past the limit. */
export function trimNoteState(state: NoteState, limit = STATE_LIMIT): NoteState {
  const trim = (m: Record<string, number>): Record<string, number> => {
    const entries = Object.entries(m)
    if (entries.length <= limit) return m
    return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, limit))
  }
  return { liked: trim(state.liked), boosted: trim(state.boosted), zapped: trim(state.zapped) }
}
