import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nip19 from 'nostr-tools/nip19'
import {
  bech32Decode, bech32Encode, bech32EncodeWords, buildInvoiceUrl, checkAmount, decodeBolt11, describePublish, directReplies,
  lightningAddressUrl, likeTemplate, lnurlDecode, lnurlEncode, normalizeRelay, parseBolt11Amount,
  parseLightningAddress, parseNoteState, parsePayParams, parseRelayList, parentOf, payTargetFromProfile,
  replyTags, replyTemplate, repostTemplate, selectPublishRelays, sha256Hex, trimNoteState,
  validateInvoice, validateReceipt, zapRequestTemplate,
} from '../src/note-logic.ts'

const pk = (c) => c.repeat(64)
const ME = pk('a')
const AUTHOR = pk('b')
const ID = pk('1')
const ROOT = pk('2')

// ─── NIP-10 ──────────────────────────────────────────────────────────────────

test('reply to a top-level note: one root e tag, author p tag', () => {
  const tags = replyTags({ id: ID, pubkey: AUTHOR, tags: [] }, { relay: 'wss://r.example', self: ME })
  assert.deepEqual(tags, [['e', ID, 'wss://r.example', 'root', AUTHOR], ['p', AUTHOR]])
})

test('reply to a reply: root then reply markers, participants deduplicated, never self', () => {
  const parent = {
    id: ID,
    pubkey: AUTHOR,
    tags: [['e', ROOT, 'wss://root.example', 'root', pk('c')], ['e', pk('3'), '', 'reply'], ['p', pk('c')], ['p', ME], ['p', AUTHOR], ['p', pk('d')]],
  }
  const tags = replyTags(parent, { relay: 'wss://r.example', self: ME })
  assert.deepEqual(tags[0], ['e', ROOT, 'wss://root.example', 'root', pk('c')])
  assert.deepEqual(tags[1], ['e', ID, 'wss://r.example', 'reply', AUTHOR])
  assert.deepEqual(tags.slice(2), [['p', AUTHOR], ['p', pk('c')], ['p', pk('d')]])
})

test('positional (deprecated) e tags still find the root', () => {
  const tags = replyTags({ id: ID, pubkey: AUTHOR, tags: [['e', ROOT], ['e', pk('3')]] })
  assert.equal(tags[0][1], ROOT)
  assert.equal(tags[0][3], 'root')
  assert.equal(tags[1][3], 'reply')
})

test('replyTemplate is kind 1 with trimmed content', () => {
  const ev = replyTemplate('  hi  ', { id: ID, pubkey: AUTHOR, tags: [] }, { created: 5 })
  assert.equal(ev.kind, 1)
  assert.equal(ev.content, 'hi')
  assert.equal(ev.created_at, 5)
})

test('p tags are capped at 20', () => {
  const tags = replyTags({ id: ID, pubkey: AUTHOR, tags: Array.from({ length: 50 }, (_, i) => ['p', i.toString(16).padStart(64, '0')]) })
  assert.equal(tags.filter((t) => t[0] === 'p').length, 20)
})

test('parentOf and directReplies ignore mentions and sort oldest first', () => {
  const reply = (id, t, tags) => ({ id, pubkey: AUTHOR, kind: 1, created_at: t, content: '', tags })
  const events = [
    reply(pk('5'), 30, [['e', ID, '', 'root']]),
    reply(pk('6'), 10, [['e', ID, '', 'reply']]),
    reply(pk('7'), 20, [['e', ID, '', 'mention']]),
    reply(pk('8'), 15, [['e', ROOT, '', 'root'], ['e', ID, '', 'reply']]),
    reply(pk('6'), 10, [['e', ID, '', 'reply']]),
  ]
  assert.deepEqual(directReplies(events, ID).map((e) => e.created_at), [10, 15, 30])
  assert.equal(directReplies(events, ID, 2).length, 2)
  assert.equal(parentOf({ tags: [] }), undefined)
  assert.equal(parentOf({ tags: [['e', ROOT, '', 'root'], ['e', ID, '', 'reply']] }).id, ID)
})

// ─── 7, 6, 16 ────────────────────────────────────────────────────────────────

test('like is kind 7 "+" with e, p and k tags', () => {
  const ev = likeTemplate({ id: ID, author: AUTHOR, kind: 1, relay: 'wss://r.example' }, 9)
  assert.equal(ev.kind, 7)
  assert.equal(ev.content, '+')
  assert.deepEqual(ev.tags, [['e', ID, 'wss://r.example', AUTHOR], ['p', AUTHOR, ''], ['k', '1']])
})

test('boosting a kind 1 note is kind 6 with the original as JSON', () => {
  const original = { id: ID, pubkey: AUTHOR, kind: 1, created_at: 1, content: 'x', tags: [], sig: 's' }
  const ev = repostTemplate({ id: ID, author: AUTHOR, kind: 1 }, original, 9)
  assert.equal(ev.kind, 6)
  assert.equal(JSON.parse(ev.content).id, ID)
  assert.deepEqual(ev.tags, [['e', ID, ''], ['p', AUTHOR]])
})

test('boosting another kind is kind 16 with a k tag; unknown original leaves content empty', () => {
  const ev = repostTemplate({ id: ID, author: AUTHOR, kind: 30023 }, undefined, 9)
  assert.equal(ev.kind, 16)
  assert.equal(ev.content, '')
  assert.deepEqual(ev.tags.at(-1), ['k', '30023'])
})

test('an original with a different id is never embedded', () => {
  const ev = repostTemplate({ id: ID, author: AUTHOR, kind: 1 }, { id: ROOT, pubkey: AUTHOR, kind: 1, created_at: 1, content: '', tags: [] })
  assert.equal(ev.content, '')
})

// ─── Relays ──────────────────────────────────────────────────────────────────

test('normalizeRelay accepts wss, drops ws (except localhost) and junk', () => {
  assert.equal(normalizeRelay(' wss://Relay.Example.com/ '), 'wss://relay.example.com')
  assert.equal(normalizeRelay('ws://relay.example.com'), '')
  assert.equal(normalizeRelay('ws://localhost:7777'), 'ws://localhost:7777')
  assert.equal(normalizeRelay('https://relay.example.com'), '')
  assert.equal(normalizeRelay('wss://u:p@relay.example.com'), '')
  assert.equal(normalizeRelay('nonsense'), '')
})

test('parseRelayList reads markers; no marker means both', () => {
  const list = parseRelayList({ tags: [['r', 'wss://a.example'], ['r', 'wss://b.example', 'read'], ['r', 'wss://c.example', 'write'], ['r', 'http://bad'], ['p', 'x']] })
  assert.deepEqual(list.read, ['wss://a.example', 'wss://b.example'])
  assert.deepEqual(list.write, ['wss://a.example', 'wss://c.example'])
})

test('selectPublishRelays: own write relays plus the parent author read relays, defaults only as a fallback', () => {
  const defaults = ['wss://d1.example', 'wss://d2.example']
  assert.deepEqual(selectPublishRelays({ ownWrite: ['wss://w.example'], defaults, parentRead: ['wss://p.example', 'wss://w.example'] }), ['wss://w.example', 'wss://p.example'])
  assert.deepEqual(selectPublishRelays({ defaults }), defaults)
  assert.deepEqual(selectPublishRelays({ ownWrite: [], defaults, parentRead: ['wss://p.example'] }), [...defaults, 'wss://p.example'])
})

test('describePublish is honest about partial and zero', () => {
  assert.equal(describePublish([{ relay: 'a', ok: true }, { relay: 'b', ok: false }, { relay: 'c', ok: true }]), 'Published to 2 of 3 relays')
  assert.equal(describePublish([{ relay: 'a', ok: false }]), 'No relay accepted it (0 of 1)')
  assert.equal(describePublish([{ relay: 'a', ok: true }]), 'Published to 1 of 1 relay')
})

// ─── LNURL ───────────────────────────────────────────────────────────────────

test('lnurl round-trips and rejects non-https urls', () => {
  const url = 'https://walletofsatoshi.com/.well-known/lnurlp/someone'
  const enc = lnurlEncode(url)
  assert.match(enc, /^lnurl1/)
  assert.equal(lnurlDecode(enc), url)
  assert.equal(lnurlDecode(enc.toUpperCase()), url)
  assert.equal(lnurlDecode(lnurlEncode('http://insecure.example/x')), null)
  assert.equal(lnurlDecode(enc.slice(0, -1) + (enc.endsWith('q') ? 'p' : 'q')), null) // bad checksum
})

test('lightning addresses', () => {
  assert.equal(lightningAddressUrl('Juraj@Bednar.io'), 'https://bednar.io/.well-known/lnurlp/juraj')
  assert.equal(parseLightningAddress('not an address'), null)
  assert.equal(parseLightningAddress('a@localhost'), null)
  const t = payTargetFromProfile({ lud16: 'x@y.example', lud06: 'junk' })
  assert.equal(t.url, 'https://y.example/.well-known/lnurlp/x')
  assert.equal(t.address, 'x@y.example')
  assert.equal(payTargetFromProfile({}), null)
  assert.equal(payTargetFromProfile({ lud16: 12 }), null)
  const via06 = payTargetFromProfile({ lud06: lnurlEncode('https://y.example/pay') })
  assert.equal(via06.url, 'https://y.example/pay')
})

const goodParams = { tag: 'payRequest', callback: 'https://y.example/cb', minSendable: 1000, maxSendable: 500000000, allowsNostr: true, nostrPubkey: pk('e'), commentAllowed: 100 }

test('parsePayParams accepts a good response', () => {
  const r = parsePayParams(goodParams)
  assert.equal(r.ok, true)
  assert.equal(r.value.commentAllowed, 100)
})

test('parsePayParams rejects a bad callback, missing nostr support, bad key and odd ranges', () => {
  assert.equal(parsePayParams({ ...goodParams, callback: 'http://y.example/cb' }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, callback: 'javascript:alert(1)' }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, callback: 'https://u:p@y.example/cb' }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, allowsNostr: false }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, allowsNostr: 'true' }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, nostrPubkey: 'abc' }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, minSendable: 5000, maxSendable: 1000 }).ok, false)
  assert.equal(parsePayParams({ ...goodParams, tag: 'withdrawRequest' }).ok, false)
  assert.equal(parsePayParams({ status: 'ERROR', reason: 'x' }).ok, false)
  assert.equal(parsePayParams(null).ok, false)
  assert.equal(parsePayParams('text').ok, false)
})

test('checkAmount enforces min and max, whole sats', () => {
  const p = { minSendable: 10000, maxSendable: 1000000 }
  assert.deepEqual(checkAmount(p, 10), { ok: true, value: 10000 })
  assert.equal(checkAmount(p, 9).ok, false)
  assert.equal(checkAmount(p, 1001).ok, false)
  assert.equal(checkAmount(p, 1.5).ok, false)
  assert.equal(checkAmount(p, 0).ok, false)
  assert.match(checkAmount(p, 9).error, /smallest/)
  assert.match(checkAmount(p, 5000).error, /largest/)
})

test('buildInvoiceUrl carries amount, nostr, lnurl and an allowed comment', () => {
  const url = new URL(buildInvoiceUrl({ callback: 'https://y.example/cb?k=1', commentAllowed: 5 }, { msats: 21000, zapRequestJson: '{"a":1}', lnurl: 'lnurl1x', comment: 'toolongcomment' }))
  assert.equal(url.searchParams.get('k'), '1')
  assert.equal(url.searchParams.get('amount'), '21000')
  assert.equal(url.searchParams.get('nostr'), '{"a":1}')
  assert.equal(url.searchParams.get('comment'), 'toolo')
  const none = new URL(buildInvoiceUrl({ callback: 'https://y.example/cb', commentAllowed: 0 }, { msats: 1000, zapRequestJson: '{}', lnurl: 'l', comment: 'hi' }))
  assert.equal(none.searchParams.has('comment'), false)
})

// ─── Zap request ─────────────────────────────────────────────────────────────

test('zapRequestTemplate has relays, amount, lnurl, p, e, k', () => {
  const ev = zapRequestTemplate({ recipient: AUTHOR, eventId: ID, eventKind: 1, msats: 21000, relays: ['wss://a.example', 'wss://b.example'], lnurl: 'lnurl1x', comment: ' gm ', created: 7 })
  assert.equal(ev.kind, 9734)
  assert.equal(ev.content, 'gm')
  assert.deepEqual(ev.tags, [['relays', 'wss://a.example', 'wss://b.example'], ['amount', '21000'], ['lnurl', 'lnurl1x'], ['p', AUTHOR], ['e', ID], ['k', '1']])
  assert.equal(zapRequestTemplate({ recipient: AUTHOR, msats: 1000, relays: [], lnurl: 'l' }).tags.some((t) => t[0] === 'e'), false)
})

// ─── bolt11 ──────────────────────────────────────────────────────────────────

const words = (n, len) => Array.from({ length: len }, (_, i) => (n + i) % 32)
const hexToWords = (hex) => {
  const bits = hex.match(/../g).map((b) => parseInt(b, 16).toString(2).padStart(8, '0')).join('')
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0')
  return padded.match(/...../g).map((b) => parseInt(b, 2))
}
/** A synthetic but structurally valid invoice: timestamp, h tag, expiry, dummy signature. */
function invoice(amountPart, hashHex) {
  const ts = [0, 0, 0, 0, 0, 0, 1]
  const h = [23, 1, 20, ...hexToWords(hashHex)]
  const x = [6, 0, 2, 0, 30]
  return bech32EncodeWords('lnbc' + amountPart, [...ts, ...h, ...x, ...words(3, 104)])
}

test('parseBolt11Amount handles every multiplier and no amount', () => {
  assert.equal(parseBolt11Amount('lnbc2500u1pxyz'), 250000000n)
  assert.equal(parseBolt11Amount('lnbc1m1pxyz'), 100000000n)
  assert.equal(parseBolt11Amount('lnbc20n1pxyz'), 2000n)
  assert.equal(parseBolt11Amount('lnbc1230p1pxyz'), 123n)
  assert.equal(parseBolt11Amount('lnbc1pxyz'), null) // no amount; p starts the data
  assert.equal(parseBolt11Amount('lnbc1u1pxyz'), 100000n)
  assert.equal(parseBolt11Amount('lnbc15p1pxyz'), null) // sub-millisatoshi
  assert.equal(parseBolt11Amount('lntb21u1pxyz'), 2100000n)
  assert.equal(parseBolt11Amount('lnbcrt10u1pxyz'), 1000000n)
  assert.equal(parseBolt11Amount('garbage'), null)
})

test('bech32 agrees with nostr-tools, so the checksum code is the standard one', () => {
  const hex = 'b'.repeat(64)
  const bytes = hex.match(/../g).map((h) => parseInt(h, 16))
  assert.equal(bech32Encode('npub', bytes), nip19.npubEncode(hex))
  assert.ok(bech32Decode(nip19.npubEncode(hex)))
})

test('decodeBolt11 reads amount, description hash, expiry and timestamp', async () => {
  const hash = 'ab'.repeat(32)
  const d = decodeBolt11(invoice('10u', hash))
  assert.equal(d.amountMsats, 1000000n)
  assert.equal(d.descriptionHash, hash)
  assert.equal(d.expiry, 30)
  assert.equal(d.timestamp, 1)
})

test('decodeBolt11 rejects a corrupted checksum', () => {
  const inv = invoice('10u', 'ab'.repeat(32))
  assert.ok(decodeBolt11(inv))
  assert.equal(decodeBolt11(inv.slice(0, -1) + (inv.endsWith('q') ? 'p' : 'q')), null)
})

// ─── Invoice and receipt validation ──────────────────────────────────────────

async function scenario() {
  const zr = { id: pk('4'), pubkey: ME, kind: 9734, created_at: 10, content: '', tags: [['amount', '21000'], ['p', AUTHOR], ['e', ID]], sig: 'x'.repeat(128) }
  const json = JSON.stringify(zr)
  const hash = await sha256Hex(json)
  return { zr, json, hash, inv: invoice('210n', hash) }
}

test('validateInvoice accepts a matching invoice', async () => {
  const { json, inv } = await scenario()
  const r = await validateInvoice(inv, { msats: 21000, zapRequestJson: json })
  assert.equal(r.ok, true)
})

test('validateInvoice rejects a wrong amount, a wrong hash, no amount and non-invoices', async () => {
  const { json, hash, inv } = await scenario()
  const wrongAmount = await validateInvoice(inv, { msats: 100000, zapRequestJson: json })
  assert.equal(wrongAmount.ok, false)
  assert.match(wrongAmount.error, /not the 100 you chose/)
  assert.equal((await validateInvoice(invoice('210n', 'cd'.repeat(32)), { msats: 21000, zapRequestJson: json })).ok, false)
  assert.equal((await validateInvoice(invoice('', hash), { msats: 21000, zapRequestJson: json })).ok, false)
  assert.equal((await validateInvoice('not an invoice', { msats: 21000, zapRequestJson: json })).ok, false)
  assert.equal((await validateInvoice({ pr: 1 }, { msats: 21000, zapRequestJson: json })).ok, false)
})

test('validateReceipt accepts the genuine receipt', async () => {
  const { zr, json, inv } = await scenario()
  const nostrPubkey = pk('e')
  const receipt = { id: pk('9'), pubkey: nostrPubkey, kind: 9735, created_at: 11, content: '', tags: [['p', AUTHOR], ['e', ID], ['bolt11', inv], ['description', json]] }
  const r = await validateReceipt(receipt, { zapRequest: zr, zapRequestJson: json, nostrPubkey, invoice: inv })
  assert.equal(r.ok, true)
  assert.equal(r.value.msats, 21000)
})

test('validateReceipt rejects wrong signer, invoice, request, amount and hash', async () => {
  const { zr, json, hash, inv } = await scenario()
  const nostrPubkey = pk('e')
  const base = { id: pk('9'), pubkey: nostrPubkey, kind: 9735, created_at: 11, content: '', tags: [['bolt11', inv], ['description', json]] }
  const exp = { zapRequest: zr, zapRequestJson: json, nostrPubkey, invoice: inv }
  assert.equal((await validateReceipt(base, exp)).ok, true)
  assert.equal((await validateReceipt({ ...base, pubkey: pk('f') }, exp)).ok, false)
  assert.equal((await validateReceipt({ ...base, kind: 1 }, exp)).ok, false)
  assert.equal((await validateReceipt({ ...base, tags: [['bolt11', invoice('210n', await sha256Hex('other'))], ['description', json]] }, exp)).ok, false)
  assert.equal((await validateReceipt({ ...base, tags: [['bolt11', inv]] }, exp)).ok, false)
  assert.equal((await validateReceipt({ ...base, tags: [['bolt11', inv], ['description', '{"id":"x"}']] }, exp)).ok, false)
  assert.equal((await validateReceipt({ ...base, tags: [['bolt11', inv], ['description', 'nope']] }, exp)).ok, false)
  const other = invoice('100n', hash)
  assert.equal((await validateReceipt({ ...base, tags: [['bolt11', other], ['description', json]] }, { ...exp, invoice: other })).ok, false)
  assert.equal((await validateReceipt(base, { ...exp, invoice: other })).ok, false)
})

// ─── Local state ─────────────────────────────────────────────────────────────

test('note state parsing drops malformed entries and trims to the newest', () => {
  assert.deepEqual(parseNoteState(null), { liked: {}, boosted: {}, zapped: {} })
  assert.deepEqual(parseNoteState('not json'), { liked: {}, boosted: {}, zapped: {} })
  const s = parseNoteState(JSON.stringify({ liked: { [ID]: 5, nothex: 6, [ROOT]: 'x' }, boosted: [], zapped: { [ID]: 21 } }))
  assert.deepEqual(s, { liked: { [ID]: 5 }, boosted: {}, zapped: { [ID]: 21 } })
  const big = { liked: { a: 1, b: 3, c: 2 }, boosted: {}, zapped: {} }
  assert.deepEqual(trimNoteState(big, 2).liked, { b: 3, c: 2 })
})
