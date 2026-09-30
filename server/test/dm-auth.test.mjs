import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createDmInbox, createDmPool, createDmSender, createMemorySeenStore, createRelayResolver } from '../dist/dm/index.js'
import { configureWebSocket } from '../dist/websocket.js'
import { startMockRelay } from './dm-mock-relay.mjs'

configureWebSocket()
const silent = { info() {}, warn() {} }
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)) }
  throw new Error('timed out waiting')
}

// Regression: a relay that refuses gift-wrap subscriptions until the reader logs in
// (NIP-42) silently made the bot deaf on that relay.
test('the inbox answers a relay\'s NIP-42 challenge and still receives DMs', { timeout: 30000 }, async () => {
  const relay = await startMockRelay({ requireAuth: true })
  const botSk = generateSecretKey(); const userSk = generateSecretKey()
  const botPk = getPublicKey(botSk)
  const pools = []
  const mk = () => { const p = createDmPool(); pools.push(p); return p }
  const userPool = mk(); const botPool = mk()
  const sender = createDmSender({
    pool: userPool, secretKey: userSk, selfRelays: [relay.url], log: silent,
    resolver: createRelayResolver({ pool: userPool, indexers: [relay.url], fallback: [relay.url], allowInsecureRelays: true, lookupWaitMs: 300 }),
  })
  const got = []
  const inbox = createDmInbox({ pool: botPool, secretKey: botSk, relays: [relay.url], seen: createMemorySeenStore(), log: silent, onMessage: (dm) => { got.push(dm) } })
  try {
    inbox.start()
    await until(() => relay.authed.includes(botPk))
    await sender.send(botPk, 'help me')
    const dm = await until(() => got[0])
    assert.equal(dm.content, 'help me')
    assert.equal(dm.senderPubkey, getPublicKey(userSk))
    assert.ok(relay.authed.every((pk) => pk === botPk), 'only the bot logged in')
  } finally {
    await inbox.stop()
    for (const p of pools) p.close([relay.url])
    await relay.close()
  }
})
