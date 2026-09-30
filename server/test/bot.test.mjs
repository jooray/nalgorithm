import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { openDb } from '../dist/db.js'
import { createBot, createDbSeenStore, MAX_MESSAGES_PER_HOUR } from '../dist/bot.js'
import { createDmInbox, createDmPool, createDmSender, createRelayResolver } from '../dist/dm/index.js'
import { configureWebSocket } from '../dist/websocket.js'
import { loadSchedule } from '../dist/schedule.js'
import { loadSettings } from '../dist/settings.js'
import { startMockRelay } from './dm-mock-relay.mjs'

configureWebSocket()
const silent = { info() {}, warn() {} }

let shared
after(async () => { await shared?.close() })
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['link_previews', 'peers', 'deliveries', 'digests', 'schedules', 'seen_wraps', 'scores', 'learned', 'settings', 'sessions', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)) }
  throw new Error('timed out waiting')
}

/** A bot and a user, each with their own pool, talking through one in-process relay. */
async function rig(over = {}) {
  const relay = await startMockRelay()
  const botSk = generateSecretKey(); const userSk = generateSecretKey()
  const botPk = getPublicKey(botSk); const userPk = getPublicKey(userSk)
  const db = await freshDb()
  const pools = []
  const mk = (sk) => {
    const pool = createDmPool(); pools.push(pool)
    const resolver = createRelayResolver({ pool, indexers: [relay.url], fallback: [relay.url], allowInsecureRelays: true, lookupWaitMs: 300 })
    return { pool, sender: createDmSender({ pool, resolver, secretKey: sk, selfRelays: [relay.url], log: silent, wrap: {} }) }
  }
  const b = mk(botSk); const u = mk(userSk)
  const sender = { async send(to, text, opts) { return (await b.sender.send(to, text, opts)).map((r) => ({ delivered: r.delivered, tier: r.tier })) } }
  const calls = { charges: [], digests: [] }
  const bot = createBot({
    db, sender, log: silent,
    commands: {
      db, webUrl: 'https://example.test/', now: () => Math.floor(Date.now() / 1000),
      billing: { async entitlement() { return { state: 'trial', until: Math.floor(Date.now() / 1000) + 86400 } }, async createCharge(npub, plan, sats) { calls.charges.push({ npub, plan, sats }); return { invoice_id: 'i', checkout_url: 'https://pay.example/i/i' } } },
      runDigestNow: async (npub) => { calls.digests.push(npub); return 'On its way.' },
    },
  })
  const botInbox = createDmInbox({ pool: b.pool, secretKey: botSk, relays: [relay.url], seen: createDbSeenStore(db), log: silent, onMessage: (dm) => bot.onMessage(dm) })
  const replies = []
  const userInbox = createDmInbox({ pool: u.pool, secretKey: userSk, relays: [relay.url], seen: { async has() { return false }, async add() {} }, log: silent, onMessage: (dm) => { replies.push(dm) } })
  botInbox.start(); userInbox.start()
  await new Promise((r) => setTimeout(r, 400))
  return {
    relay, db, botPk, userPk, calls, replies,
    say: (text, format) => u.sender.send(botPk, text, format ? { format } : undefined),
    async stop() { await botInbox.stop(); await userInbox.stop(); for (const p of pools) p.close([relay.url]); await relay.close() },
  }
}

test('end to end: a DM command changes the schedule and the reply comes back to the sender', { timeout: 30000 }, async () => {
  const r = await rig()
  try {
    await r.say('time 07:30')
    const reply = await until(() => r.replies.find((m) => /Daily digest at 07:30/.test(m.content)))
    assert.equal(reply.senderPubkey, r.botPk, 'the reply comes from the bot')
    assert.equal(reply.protocol, 'nip17')
    const s = await loadSchedule(r.db, r.userPk)
    assert.equal(s.enabled, true); assert.equal(s.hour, 7); assert.equal(s.minute, 30)
    await r.say('prompt: bitcoin and nostr')
    await until(() => r.replies.find((m) => /Prompt saved/.test(m.content)))
    assert.equal((await loadSettings(r.db, r.userPrompt ?? r.userPk)).userPrompt, 'bitcoin and nostr')
  } finally { await r.stop() }
})

test('end to end: the bot answers a kind 4 sender in kind 4, and never in both formats', { timeout: 30000 }, async () => {
  const r = await rig()
  try {
    await r.say('status', 'nip04')
    const reply = await until(() => r.replies.find((m) => /Subscription:/.test(m.content)))
    assert.equal(reply.protocol, 'nip04')
    await new Promise((res) => setTimeout(res, 600))
    assert.equal(r.replies.filter((m) => /Subscription:/.test(m.content)).length, 1, 'one reply, in one format')
    const peer = await r.db.get('SELECT dm_kind FROM peers WHERE npub = ?', [r.userPk])
    assert.equal(peer.dm_kind, 'nip04')
    // an explicit choice overrides following the peer
    await r.say('nip17', 'nip04')
    await until(() => r.replies.find((m) => /modern \(NIP-17\)/.test(m.content)))
    await r.say('status', 'nip04')
    const next = await until(() => r.replies.filter((m) => /Subscription:/.test(m.content))[1])
    assert.equal(next.protocol, 'nip17')
  } finally { await r.stop() }
})

test('end to end: free text is not a prompt, pay and digest reach their handlers with the verified sender', { timeout: 30000 }, async () => {
  const r = await rig()
  try {
    await r.say('I love bitcoin and nostr')
    await until(() => r.replies.find((m) => /did not understand/.test(m.content)))
    assert.equal((await loadSettings(r.db, r.userPk)).userPrompt, '', 'free text changed nothing')
    await r.say('pay 5000')
    const pay = await until(() => r.replies.find((m) => /5000 sats/.test(m.content)))
    assert.match(pay.content, /https:\/\/pay\.example\/i\/i/)
    await r.say('digest')
    await until(() => r.replies.find((m) => m.content === 'On its way.'))
    assert.deepEqual(r.calls.charges, [{ npub: r.userPk, plan: 'nalgorithm', sats: 5000 }])
    assert.deepEqual(r.calls.digests, [r.userPk])
  } finally { await r.stop() }
})

test('the bot does not answer its own self-copies, so there is no reply loop', { timeout: 30000 }, async () => {
  const r = await rig()
  try {
    await r.say('help')
    await until(() => r.replies.find((m) => /nalgorithm ranks/.test(m.content)))
    await new Promise((res) => setTimeout(res, 1000))
    const helpReplies = r.replies.filter((m) => /nalgorithm ranks/.test(m.content)).length
    assert.equal(helpReplies, 1)
    const wraps = r.relay.events.filter((e) => e.kind === 1059).length
    assert.ok(wraps <= 4, `one request and one reply, each with a self-copy (got ${wraps} wraps)`)
  } finally { await r.stop() }
})

test('a sender over the hourly limit is ignored', async () => {
  const db = await freshDb()
  const sent = []
  const bot = createBot({ db, log: silent, sender: { async send(to, text) { sent.push(text); return [{ delivered: true }] } },
    commands: { db, webUrl: 'x', billing: { async entitlement() { return { state: 'none' } }, async createCharge() { return { invoice_id: 'i', checkout_url: 'u' } } }, runDigestNow: async () => 'ok' } })
  const dm = { senderPubkey: 'c'.repeat(64), content: 'help', protocol: 'nip17', rumorId: 'x', createdAt: 0, receivedAt: 0 }
  for (let i = 0; i < MAX_MESSAGES_PER_HOUR + 10; i++) await bot.onMessage({ ...dm, rumorId: String(i) })
  assert.equal(sent.length, MAX_MESSAGES_PER_HOUR)
})

test('the database seen store remembers ids and prunes old ones', async () => {
  const db = await freshDb()
  let t = 1_800_000_000
  const seen = createDbSeenStore(db, () => t)
  assert.equal(await seen.has('a'), false)
  await seen.add('a'); await seen.add('a')
  assert.equal(await seen.has('a'), true)
  t += 8 * 86400
  await seen.add('b')
  assert.equal(await seen.prune(7), 1)
  assert.equal(await seen.has('a'), false); assert.equal(await seen.has('b'), true)
})
