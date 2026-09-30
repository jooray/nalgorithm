import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { configureWebSocket } from '../dist/websocket.js'
import { createDmInbox, createDmSender, createMemorySeenStore, createRelayResolver, buildRumor, wrapRumor } from '../dist/dm/index.js'
import { startMockRelay } from './dm-mock-relay.mjs'

const botSk = generateSecretKey()
const botPk = getPublicKey(botSk)
const aliceSk = generateSecretKey()
const alicePk = getPublicKey(aliceSk)
const DEAD = 'ws://127.0.0.1:1'
const fast = { timeoutMs: 400, sleep: async () => {} }

let pool
const relays = []
const inboxes = []
before(() => {
  configureWebSocket()
  pool = new SimplePool({ enableReconnect: true, enablePing: true })
})
after(async () => {
  await Promise.all(inboxes.map((i) => i.stop()))
  pool.destroy()
  await Promise.all(relays.map((r) => r.close()))
})
async function relay() {
  const r = await startMockRelay()
  relays.push(r)
  return r
}
async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

function makeInbox(relayUrls, { seen = createMemorySeenStore() } = {}) {
  const messages = []
  const logs = []
  const inbox = createDmInbox({
    pool,
    secretKey: botSk,
    relays: relayUrls,
    seen,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    onMessage: (dm) => void messages.push(dm),
  })
  inboxes.push(inbox)
  return { inbox, messages, logs, seen }
}

/** A wrap addressed to the bot, sealed by `sealKey`, carrying `rumor`. */
function wrapTo(rumor, sealKey = aliceSk) {
  return wrapRumor(sealKey, rumor, botPk)
}

test('receives a message sent through the sender, live and from stored history', async () => {
  const r = await relay()
  const stub = { async querySync() { return [] } }
  const resolver = createRelayResolver({ pool: stub, indexers: [], fallback: [r.url], allowInsecureRelays: true })
  const send = createDmSender({ pool, resolver, secretKey: aliceSk, selfRelays: [], publish: fast }).send

  const { inbox, messages } = makeInbox([r.url])
  inbox.start()
  await settle(200)
  const [sent] = await send(botPk, 'live message')
  assert.equal(sent.delivered, true)
  await waitFor(() => messages.length === 1)
  const dm = messages[0]
  assert.equal(dm.senderPubkey, alicePk)
  assert.equal(dm.content, 'live message')
  assert.equal(dm.protocol, 'nip17')
  assert.equal(dm.rumorId, sent.rumorId)
  assert.equal(dm.relay, r.url)
  assert.ok(dm.receivedAt >= dm.createdAt - 1)

  // A second inbox started later reads the same message from the relay's history.
  await send(botPk, 'stored message')
  const late = makeInbox([r.url])
  late.inbox.start()
  await waitFor(() => late.messages.length === 2)
  assert.deepEqual(late.messages.map((m) => m.content).sort(), ['live message', 'stored message'])
})

test('the subscription asks for both kinds, addressed to the bot, three days back', async () => {
  const r = await relay()
  const { inbox } = makeInbox([r.url])
  const before = Math.floor(Date.now() / 1000)
  inbox.start()
  await waitFor(() => r.reqs.length === 1)
  const [wrapFilter, legacyFilter] = r.reqs[0]
  assert.deepEqual([wrapFilter.kinds, wrapFilter['#p']], [[1059], [botPk]])
  assert.deepEqual([legacyFilter.kinds, legacyFilter['#p']], [[4], [botPk]])
  for (const f of r.reqs[0]) assert.ok(Math.abs(f.since - (before - 3 * 86400)) <= 5)
})

test('the same wrap from two relays is delivered once', async () => {
  const r1 = await relay()
  const r2 = await relay()
  const wrap = wrapTo(buildRumor(alicePk, botPk, 'once only'))
  r1.seed(wrap)
  r2.seed(wrap)
  const { inbox, messages } = makeInbox([r1.url, r2.url])
  inbox.start()
  await waitFor(() => messages.length === 1)
  await settle(500)
  assert.equal(messages.length, 1)
  // A late live copy is still ignored.
  r2.broadcast(wrap)
  await settle(300)
  assert.equal(messages.length, 1)
})

test('a persistent seen-store survives a restart', async () => {
  const r = await relay()
  const wrap = wrapTo(buildRumor(alicePk, botPk, 'already handled'))
  r.seed(wrap)
  const added = []
  const seen = { has: async (id) => added.includes(id), add: async (id) => void added.push(id) }
  const first = makeInbox([r.url], { seen })
  first.inbox.start()
  await waitFor(() => first.messages.length === 1)
  await first.inbox.stop()
  assert.deepEqual(added, [wrap.id])
  // nostr-tools deletes a relay from the pool when its old socket finishes
  // closing, which would orphan a connection opened to the same URL meanwhile.
  await settle(300)
  const second = makeInbox([r.url], { seen })
  second.inbox.start()
  await settle(500)
  assert.equal(second.messages.length, 0)
})

test('a forged wrap (seal author differs from rumor author) is marked seen and never delivered', async () => {
  const r = await relay()
  const mallory = generateSecretKey()
  const forged = wrapTo(buildRumor(alicePk, botPk, '/admin do something'), mallory)
  r.seed(forged)
  const { inbox, messages, logs, seen } = makeInbox([r.url])
  inbox.start()
  await waitFor(() => logs.some((l) => l.includes('pubkey_mismatch')))
  await settle(200)
  assert.equal(messages.length, 0)
  assert.equal(await seen.has(forged.id), true)
})

test('junk wraps and undecryptable events are dropped without stopping the inbox', async () => {
  const r = await relay()
  const junk = finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', botPk]], content: 'garbage' }, generateSecretKey())
  const badLegacy = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', botPk]], content: 'garbage' }, aliceSk)
  r.seed(junk)
  r.seed(badLegacy)
  r.seed(wrapTo(buildRumor(alicePk, botPk, 'good one')))
  const { inbox, messages, seen } = makeInbox([r.url])
  inbox.start()
  await waitFor(() => messages.length === 1)
  await settle(300)
  assert.equal(await seen.has(junk.id), true, 'decrypt failures are permanent')
  assert.equal(await seen.has(badLegacy.id), true)
})

test('the bot\'s own self-copies are not delivered as incoming messages', async () => {
  const r = await relay()
  const rumor = buildRumor(botPk, alicePk, 'sent by me')
  r.seed(wrapRumor(botSk, rumor, botPk))
  r.seed(wrapTo(buildRumor(alicePk, botPk, 'from alice')))
  const { inbox, messages } = makeInbox([r.url])
  inbox.start()
  await waitFor(() => messages.length >= 1)
  await settle(300)
  assert.deepEqual(messages.map((m) => m.content), ['from alice'])
})

test('kind 4 (NIP-04) messages addressed to the bot are received', async () => {
  const r = await relay()
  const ev = finalizeEvent(
    { kind: 4, created_at: Math.floor(Date.now() / 1000) - 10, tags: [['p', botPk]], content: nip04.encrypt(aliceSk, botPk, 'legacy hi') },
    aliceSk,
  )
  r.seed(ev)
  const { inbox, messages } = makeInbox([r.url])
  inbox.start()
  await waitFor(() => messages.length === 1)
  assert.deepEqual(
    { s: messages[0].senderPubkey, c: messages[0].content, p: messages[0].protocol, id: messages[0].rumorId, rel: messages[0].relay },
    { s: alicePk, c: 'legacy hi', p: 'nip04', id: ev.id, rel: r.url },
  )
})

test('createdAt is clamped to 15 minutes ahead of now', async () => {
  const r = await relay()
  const future = Math.floor(Date.now() / 1000) + 30 * 86400
  const draft = { pubkey: alicePk, created_at: future, kind: 14, tags: [['p', botPk]], content: 'from the future' }
  r.seed(wrapTo({ ...draft, id: getEventHash(draft) }))
  const { inbox, messages } = makeInbox([r.url])
  inbox.start()
  await waitFor(() => messages.length === 1)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(messages[0].createdAt <= now + 15 * 60 && messages[0].createdAt > now)
})

test('an unreachable relay crashes nothing and does not block the others', async () => {
  let uncaught
  const onUncaught = (e) => { uncaught = e }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
  try {
    const r = await relay()
    r.seed(wrapTo(buildRumor(alicePk, botPk, 'reached anyway')))
    const { inbox, messages, logs } = makeInbox([DEAD, r.url])
    inbox.start()
    await waitFor(() => messages.length === 1)
    await waitFor(() => logs.some((l) => l.includes(DEAD) && l.includes('retrying')))
    await settle(300)
    await inbox.stop()
    assert.equal(uncaught, undefined, String(uncaught?.stack ?? uncaught))
  } finally {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUncaught)
  }
})

test('stop() leaves no open handles: a process that starts and stops an inbox exits by itself', { timeout: 30000 }, async () => {
  const dist = pathToFileURL(fileURLToPath(new URL('../dist/', import.meta.url))).href
  const helper = pathToFileURL(fileURLToPath(new URL('./dm-mock-relay.mjs', import.meta.url))).href
  const script = `
    import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
    import { SimplePool } from 'nostr-tools/pool'
    import { configureWebSocket } from '${dist}websocket.js'
    import { createDmInbox, createMemorySeenStore, buildRumor, wrapRumor } from '${dist}dm/index.js'
    import { startMockRelay } from '${helper}'
    configureWebSocket()
    const bot = generateSecretKey(), alice = generateSecretKey()
    const relay = await startMockRelay()
    relay.seed(wrapRumor(alice, buildRumor(getPublicKey(alice), getPublicKey(bot), 'hi'), getPublicKey(bot)))
    let got = 0
    const inbox = createDmInbox({
      pool: new SimplePool({ enableReconnect: true, enablePing: true }),
      secretKey: bot,
      relays: [relay.url, 'ws://127.0.0.1:1'],
      seen: createMemorySeenStore(),
      onMessage: () => { got++ },
    })
    inbox.start()
    const end = Date.now() + 5000
    while (!got && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 300))
    await inbox.stop()
    await relay.close()
    console.log('got', got)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.match(out, /got 1/)
  assert.equal(code, 0, out)
})
