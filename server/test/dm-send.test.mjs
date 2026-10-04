import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import { SimplePool } from 'nostr-tools/pool'
import { configureWebSocket } from '../dist/websocket.js'
import { createDmSender, createRelayResolver, unwrapGiftWrap, splitMessage, DmSendError } from '../dist/dm/index.js'
import { startMockRelay } from './dm-mock-relay.mjs'

const botSk = generateSecretKey()
const botPk = getPublicKey(botSk)
const peerSk = generateSecretKey()
const peerPk = getPublicKey(peerSk)
const fast = { timeoutMs: 400, sleep: async () => {} }
const warnings = []
const log = { info() {}, warn: (m) => warnings.push(m) }

let pool
const relays = []
before(() => {
  configureWebSocket()
  pool = new SimplePool()
})
after(async () => {
  pool.destroy()
  await Promise.all(relays.map((r) => r.close()))
})
async function relay(mode = 'ok') {
  const r = await startMockRelay({ ackMode: mode })
  relays.push(r)
  return r
}

/** Sender whose recipient's DM relays and the bot's own inbox are mock relays. */
async function setup({ recipientMode = 'ok', selfMode = 'ok', outbox } = {}) {
  const theirs = await relay(recipientMode)
  const mine = await relay(selfMode)
  const indexer = await relay()
  const { finalizeEvent } = await import('nostr-tools/pure')
  indexer.seed(finalizeEvent({ kind: 10050, created_at: 100, tags: [['relay', theirs.url]], content: '' }, peerSk))
  const resolver = createRelayResolver({ pool, indexers: [indexer.url], fallback: [mine.url], allowInsecureRelays: true })
  const sender = createDmSender({ pool, resolver, secretKey: botSk, selfRelays: [mine.url], log, publish: fast, outbox })
  return { theirs, mine, sender }
}

test('nip17: a kind 1059 wrap for the recipient plus a self-copy, same rumor', async () => {
  const { theirs, mine, sender } = await setup()
  const [res, ...rest] = await sender.send(peerPk, 'hello there')
  assert.equal(rest.length, 0)
  assert.equal(res.delivered, true)
  assert.equal(res.protocol, 'nip17')
  assert.equal(res.tier, 'inbox')
  assert.equal(res.relays[theirs.url].status, 'ok')

  assert.equal(theirs.events.length, 1)
  const toPeer = theirs.events[0]
  assert.equal(toPeer.kind, 1059)
  assert.deepEqual(toPeer.tags, [['p', peerPk]])
  assert.equal(toPeer.id, res.eventId)
  const opened = unwrapGiftWrap(toPeer, peerSk)
  assert.equal(opened.senderPubkey, botPk)
  assert.equal(opened.rumor.content, 'hello there')
  assert.equal(opened.rumor.id, res.rumorId)

  assert.equal(mine.events.length, 1)
  const toSelf = mine.events[0]
  assert.deepEqual(toSelf.tags, [['p', botPk]])
  assert.notEqual(toSelf.id, toPeer.id)
  assert.equal(unwrapGiftWrap(toSelf, botSk).rumor.id, res.rumorId)
  assert.equal(res.selfCopy.delivered, true)
  assert.equal(res.selfCopy.eventId, toSelf.id)
  assert.equal(mine.events.some((e) => e.kind === 4), false, 'never both formats')
  assert.equal(theirs.events.some((e) => e.kind === 4), false)
})

test('nip17: a failed self-copy does not fail the send', async () => {
  const { theirs, sender } = await setup({ selfMode: 'reject' })
  const [res] = await sender.send(peerPk, 'still delivered')
  assert.equal(res.delivered, true)
  assert.equal(res.selfCopy.delivered, false)
  assert.equal(theirs.events.length, 1)
  assert.ok(warnings.some((w) => w.includes('self-copy')))
})

test('nip17: a rejected recipient copy is reported as not delivered', async () => {
  const { sender } = await setup({ recipientMode: 'reject' })
  const [res] = await sender.send(peerPk, 'nope')
  assert.equal(res.delivered, false)
  assert.equal(Object.values(res.relays)[0].status, 'rejected')
})

test('durable outbox retries the same signed wrap and skips delivered parts', async () => {
  const stored = new Map()
  const outbox = { async get(key) { return stored.get(key) ?? null }, async put(key, _recipient, value) { stored.set(key, value) } }
  const { theirs, sender } = await setup({ recipientMode: 'reject', outbox })
  const [failed] = await sender.send(peerPk, 'persisted message', { idempotencyKey: 'digest:1' })
  theirs.ackMode = 'ok'
  const [sent] = await sender.send(peerPk, 'persisted message', { idempotencyKey: 'digest:1' })
  assert.equal(sent.eventId, failed.eventId); assert.equal(sent.rumorId, failed.rumorId); assert.equal(sent.delivered, true)
  const before = theirs.events.length
  await sender.send(peerPk, 'persisted message', { idempotencyKey: 'digest:1' })
  assert.equal(theirs.events.length, before)
})

test('extra relays are used in addition to the resolved ones', async () => {
  const { theirs, sender } = await setup()
  const observed = await relay()
  const [res] = await sender.send(peerPk, 'also there', { extraRelays: [observed.url] })
  assert.deepEqual(Object.keys(res.relays).sort(), [theirs.url, observed.url].sort())
  assert.equal(observed.events.length, 1)
})

test('long text is split at paragraph boundaries and sent in order', async () => {
  const { theirs, sender } = await setup()
  const para = (c) => c.repeat(1500)
  const text = [para('a'), para('b'), para('c'), para('d')].join('\n\n')
  const results = await sender.send(peerPk, text)
  assert.equal(results.length, 2)
  assert.ok(results.every((r) => r.delivered))
  const rumors = theirs.events.map((e) => unwrapGiftWrap(e, peerSk).rumor).sort((x, y) => x.created_at - y.created_at)
  assert.deepEqual(rumors.map((r) => r.content), [`${para('a')}\n\n${para('b')}`, `${para('c')}\n\n${para('d')}`])
  assert.ok(rumors[0].created_at < rumors[1].created_at, 'strictly increasing so clients keep the order')
  assert.ok(rumors.every((r) => r.content.length < 4000))
})

test('splitMessage falls back to lines, spaces and hard cuts', () => {
  const words = Array.from({ length: 1200 }, () => 'word').join(' ')
  const parts = splitMessage(words)
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 4000))
  assert.equal(parts.join(' '), words)
  const solid = 'x'.repeat(9000)
  assert.deepEqual(splitMessage(solid).map((p) => p.length), [4000, 4000, 1000])
  const emoji = '\u{1F600}'.repeat(3000)
  for (const p of splitMessage(emoji)) assert.equal(p, [...p].join(''), 'no broken surrogate pairs')
})

test('a part that is not delivered stops the remaining parts', async () => {
  const { theirs, sender } = await setup({ recipientMode: 'reject' })
  const results = await sender.send(peerPk, ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n'))
  assert.equal(results.length, 1)
  assert.equal(results[0].delivered, false)
  assert.equal(theirs.attempts.length, 1)
})

test('empty, oversized and badly addressed messages are refused before anything is published', async () => {
  const { theirs, mine, sender } = await setup()
  const refused = (p, reason) => assert.rejects(p, (e) => e instanceof DmSendError && e.reason === reason)
  await refused(sender.send(peerPk, ''), 'empty')
  await refused(sender.send(peerPk, ' \n\t '), 'empty')
  await refused(sender.send(peerPk, 'x'.repeat(8001)), 'too_long')
  await refused(sender.send('npub1notahexkey', 'hi'), 'bad_recipient')
  assert.equal((await sender.send(peerPk, 'x'.repeat(8000))).length, 2)
  assert.equal(theirs.attempts.length, 2)
  assert.equal(mine.attempts.length, 2)
})

test('nip04: a single kind 4 the recipient can decrypt, no wrap, no self-copy', async () => {
  const { theirs, mine, sender } = await setup()
  const [res] = await sender.send(peerPk, 'legacy hello', { format: 'nip04' })
  assert.equal(res.delivered, true)
  assert.equal(res.protocol, 'nip04')
  assert.equal(res.selfCopy, undefined)
  assert.equal(theirs.events.length, 1)
  const ev = theirs.events[0]
  assert.equal(ev.kind, 4)
  assert.equal(ev.pubkey, botPk)
  assert.deepEqual(ev.tags, [['p', peerPk]])
  assert.equal(nip04.decrypt(peerSk, botPk, ev.content), 'legacy hello')
  assert.equal(theirs.events.some((e) => e.kind === 1059), false)
  assert.equal(mine.events.length, 0)
})
