import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { configureWebSocket } from '../dist/websocket.js'
import { createRelayResolver, isAcceptableRelayUrl, DEFAULT_FALLBACK } from '../dist/dm/index.js'
import { startMockRelay } from './dm-mock-relay.mjs'

const peerSk = generateSecretKey()
const peer = getPublicKey(peerSk)
const FALLBACK = ['wss://fallback-a.example.com', 'wss://fallback-b.example.com']

const inboxList = (urls, at = 100, sk = peerSk) => finalizeEvent({ kind: 10050, created_at: at, tags: urls.map((u) => ['relay', u]), content: '' }, sk)
const relayList = (tags, at = 100, sk = peerSk) => finalizeEvent({ kind: 10002, created_at: at, tags, content: '' }, sk)

function fakePool(events) {
  const pool = { calls: [], async querySync(relays, filter, params) { pool.calls.push({ relays, filter, params }); return events } }
  return pool
}

test('isAcceptableRelayUrl: wss on public hosts only', () => {
  for (const ok of ['wss://relay.damus.io', 'wss://nos.lol/', 'wss://relay.example.com:8443/path', 'wss://93.184.216.34', 'wss://[2606:4700::1111]']) {
    assert.equal(isAcceptableRelayUrl(ok), true, ok)
  }
  for (const bad of [
    'ws://relay.damus.io',
    'https://relay.damus.io',
    'wss://localhost',
    'wss://foo.localhost',
    'wss://127.0.0.1',
    'wss://127.1',
    'wss://0x7f.0.0.1',
    'wss://2130706433',
    'wss://10.0.0.5',
    'wss://172.16.4.4',
    'wss://172.31.255.255',
    'wss://192.168.1.1',
    'wss://169.254.169.254',
    'wss://100.64.0.1',
    'wss://0.0.0.0',
    'wss://[::1]',
    'wss://[fe80::1]',
    'wss://[fd00::1]',
    'wss://[::ffff:127.0.0.1]',
    'wss://user:pw@relay.example.com',
    'wss://user@relay.example.com',
    'wss://intranet',
    'wss://printer.local',
    'wss://',
    'not a url',
    '',
    null,
    42,
    'wss://relay.example.com/' + 'a'.repeat(300),
  ]) {
    assert.equal(isAcceptableRelayUrl(bad), false, String(bad))
  }
  assert.equal(isAcceptableRelayUrl('wss://172.32.0.1'), true, 'outside 172.16/12 is public')
})

test('isAcceptableRelayUrl: allowInsecure admits ws:// and loopback for tests', () => {
  assert.equal(isAcceptableRelayUrl('ws://127.0.0.1:7777', true), true)
  assert.equal(isAcceptableRelayUrl('http://127.0.0.1', true), false)
})

test('default fallback list is the documented one', () => {
  assert.deepEqual(DEFAULT_FALLBACK, ['wss://nostr.cypherpunk.today', 'wss://relay.damus.io', 'wss://nos.lol'])
})

test('tier 1: the newest kind 10050 wins over everything else', async () => {
  const pool = fakePool([
    inboxList(['wss://old.example.com'], 50),
    inboxList(['wss://inbox-a.example.com', 'wss://inbox-b.example.com'], 200),
    relayList([['r', 'wss://nip65.example.com']], 999),
  ])
  const r = await createRelayResolver({ pool, indexers: ['wss://idx.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.equal(r.tier, 'inbox')
  assert.deepEqual(r.relays, ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'])
  assert.deepEqual(pool.calls[0].relays, ['wss://idx.example.com'])
  assert.deepEqual(pool.calls[0].filter, { kinds: [10050, 10002], authors: [peer] })
})

test('tier 2: NIP-65 read relays (no marker or read), when there is no usable 10050', async () => {
  const pool = fakePool([
    inboxList(['ws://plain.example.com', 'wss://localhost']), // nothing acceptable in it
    relayList([
      ['r', 'wss://both.example.com'],
      ['r', 'wss://read.example.com', 'read'],
      ['r', 'wss://write.example.com', 'write'],
      ['r', 'wss://10.0.0.1'],
    ]),
  ])
  const r = await createRelayResolver({ pool, indexers: ['wss://idx.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.equal(r.tier, 'nip65')
  assert.deepEqual(r.relays, ['wss://both.example.com', 'wss://read.example.com'])
})

test('tier 3: fallback when neither list exists', async () => {
  const r = await createRelayResolver({ pool: fakePool([]), indexers: ['wss://idx.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.equal(r.tier, 'fallback')
  assert.deepEqual(r.relays, FALLBACK)
})

test('lists published by someone else are ignored', async () => {
  const mallory = generateSecretKey()
  const pool = fakePool([inboxList(['wss://evil.example.com'], 500, mallory)])
  const r = await createRelayResolver({ pool, indexers: ['wss://idx.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.equal(r.tier, 'fallback')
})

test('a failing lookup falls back instead of throwing', async () => {
  const pool = { async querySync() { throw new Error('boom') } }
  const r = await createRelayResolver({ pool, indexers: ['wss://idx.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.equal(r.tier, 'fallback')
})

test('lists are capped at 6 relays and deduplicated', async () => {
  const urls = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example.com`)
  const r = await createRelayResolver({ pool: fakePool([inboxList([urls[0], ...urls])]), indexers: ['wss://i.example.com'], fallback: FALLBACK }).resolve(peer)
  assert.deepEqual(r.relays, urls.slice(0, 6))
})

test('extra relays are appended (max 3, deduplicated, validated) without changing the tier', async () => {
  const pool = fakePool([inboxList(['wss://inbox.example.com'])])
  const resolver = createRelayResolver({ pool, indexers: ['wss://i.example.com'], fallback: FALLBACK })
  const r = await resolver.resolve(peer, ['wss://inbox.example.com', 'wss://x1.example.com', 'ws://insecure.example.com', 'wss://x2.example.com', 'wss://x3.example.com', 'wss://x4.example.com'])
  assert.equal(r.tier, 'inbox')
  assert.deepEqual(r.relays, ['wss://inbox.example.com', 'wss://x1.example.com', 'wss://x2.example.com', 'wss://x3.example.com'])
  assert.deepEqual((await resolver.resolve(peer)).relays, ['wss://inbox.example.com'], 'extras are per call, not cached')
})

test('resolved targets are cached for 10 minutes per pubkey', async () => {
  const pool = fakePool([inboxList(['wss://inbox.example.com'])])
  let t = 1_000_000
  const resolver = createRelayResolver({ pool, indexers: ['wss://i.example.com'], fallback: FALLBACK, now: () => t })
  await resolver.resolve(peer)
  t += 9 * 60_000
  await resolver.resolve(peer)
  assert.equal(pool.calls.length, 1)
  await resolver.resolve(getPublicKey(generateSecretKey()))
  assert.equal(pool.calls.length, 2, 'other pubkeys are looked up separately')
  t += 2 * 60_000
  await resolver.resolve(peer)
  assert.equal(pool.calls.length, 3, 'expired after 10 minutes')
})

test('a fallback answer is retried sooner than a found list', async () => {
  const pool = fakePool([])
  let t = 0
  const resolver = createRelayResolver({ pool, indexers: ['wss://i.example.com'], fallback: FALLBACK, now: () => t })
  await resolver.resolve(peer)
  t += 30_000
  await resolver.resolve(peer)
  assert.equal(pool.calls.length, 1)
  t += 40_000
  await resolver.resolve(peer)
  assert.equal(pool.calls.length, 2)
})

test('concurrent lookups for one pubkey share one query', async () => {
  const pool = fakePool([])
  const resolver = createRelayResolver({ pool, indexers: ['wss://i.example.com'], fallback: FALLBACK })
  await Promise.all([resolver.resolve(peer), resolver.resolve(peer), resolver.resolve(peer)])
  assert.equal(pool.calls.length, 1)
})

test('resolves through a real pool against a mock indexer relay', async () => {
  configureWebSocket()
  const indexer = await startMockRelay()
  const pool = new SimplePool()
  try {
    indexer.seed(inboxList(['ws://127.0.0.1:9/inbox']))
    const resolver = createRelayResolver({ pool, indexers: [indexer.url], fallback: FALLBACK, allowInsecureRelays: true })
    const r = await resolver.resolve(peer)
    assert.equal(r.tier, 'inbox')
    assert.deepEqual(r.relays, ['ws://127.0.0.1:9/inbox'])
    // Without the test flag the same list is unusable and we fall back.
    const strict = createRelayResolver({ pool, indexers: [indexer.url], fallback: FALLBACK })
    assert.equal((await strict.resolve(peer)).tier, 'fallback')
  } finally {
    pool.destroy()
    await indexer.close()
  }
})
