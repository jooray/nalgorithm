import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetcher, sanitizeRelayUrl } from '../dist/index.js'

const pk = (n) => n.toString(16).padStart(64, '0')
const kind0 = (p, name) => ({ kind: 0, pubkey: p, created_at: 100, content: JSON.stringify({ name }), tags: [], id: 'x', sig: 'y' })
const list = (p, tags) => ({ kind: 10002, pubkey: p, created_at: 100, content: '', tags, id: 'x', sig: 'y' })

/** A fake pool: `serve(relay, filter)` returns events; every call is logged. */
function fakePool(serve) {
  const calls = []
  return {
    calls,
    async querySync(relays, filter) {
      calls.push({ relays, filter })
      const out = []
      for (const r of relays) out.push(...(await serve(r, filter, calls.length)))
      return out
    },
    async get() { return null },
    close() {},
  }
}

const MAIN = ['wss://main.example']
const INDEX = ['wss://index.example']
const make = (pool) => createFetcher({ relays: MAIN, profileFallbackRelays: INDEX, pool })

test('getProfiles: small-batch retry recovers what a big indexer filter dropped', async () => {
  const keys = Array.from({ length: 60 }, (_, i) => pk(i + 1))
  // The indexer answers big filters with only the first 5 authors, small ones fully.
  const pool = fakePool((relay, f) => {
    if (relay !== INDEX[0] || !f.kinds.includes(0)) return []
    const authors = f.authors.length > 25 ? f.authors.slice(0, 5) : f.authors
    return authors.map((a) => kind0(a, 'n' + a.slice(-2)))
  })
  const got = await make(pool).getProfiles(keys)
  assert.equal(got.size, 60)
  assert.ok(pool.calls.filter((c) => c.relays[0] === INDEX[0]).every((c) => c.filter.authors.length <= 25))
})

test('getProfiles: a flaky first attempt is retried once', async () => {
  const a = pk(1)
  let n = 0
  const pool = fakePool((relay, f) => (relay === INDEX[0] && f.kinds.includes(0) && ++n >= 2 ? [kind0(a, 'Minibits')] : []))
  const got = await make(pool).getProfiles([a])
  assert.equal(got.get(a)?.name, 'Minibits')
})

test('getProfiles: outbox pass asks the author write relays, sanitised and capped', async () => {
  const a = pk(1)
  const b = pk(2)
  const pool = fakePool((relay, f) => {
    if (f.kinds.includes(10002)) {
      return [
        list(a, [['r', 'wss://own.example'], ['r', 'wss://read-only.example', 'read'], ['r', 'ws://plain.example'], ['r', 'wss://127.0.0.1'], ['r', 'wss://w2.example', 'write'], ['r', 'wss://w3.example'], ['r', 'wss://w4.example']]),
        list(b, [['r', 'wss://own.example', 'write']]),
      ]
    }
    if (relay === 'wss://own.example') return f.authors.map((x) => kind0(x, 'who' + x.slice(-1)))
    return []
  })
  const got = await make(pool).getProfiles([a, b])
  assert.equal(got.get(a)?.name, 'who1')
  assert.equal(got.get(b)?.name, 'who2')
  const asked = new Set(pool.calls.filter((c) => c.filter.kinds.includes(0)).flatMap((c) => c.relays))
  assert.ok(!asked.has('wss://read-only.example'))
  assert.ok(!asked.has('ws://plain.example'))
  assert.ok(![...asked].some((r) => r.includes('127.0.0.1')))
  const relaysForA = [...asked].filter((r) => ['wss://own.example', 'wss://w2.example', 'wss://w3.example', 'wss://w4.example'].includes(r))
  assert.ok(relaysForA.length <= 4)
})

test('getProfiles: outbox pass is capped at 12 relays', async () => {
  const keys = Array.from({ length: 20 }, (_, i) => pk(i + 1))
  const pool = fakePool((relay, f) => {
    if (f.kinds.includes(10002)) return f.authors.map((a, i) => list(a, [['r', `wss://r${parseInt(a, 16)}.example`]]))
    return []
  })
  await make(pool).getProfiles(keys)
  const relays = new Set(pool.calls.filter((c) => c.filter.kinds.includes(0) && c.relays[0].startsWith('wss://r')).map((c) => c.relays[0]))
  assert.equal(relays.size, 12)
})

test('getProfiles: never throws, keeps what resolved', async () => {
  const a = pk(1)
  const b = pk(2)
  const pool = fakePool((relay, f) => {
    if (relay === MAIN[0]) return [kind0(a, 'Alice')]
    throw new Error('relay down')
  })
  const got = await make(pool).getProfiles([a, b])
  assert.equal(got.get(a)?.name, 'Alice')
  assert.ok(!got.has(b))
})

test('getProfiles: skips outbox events from the wrong author', async () => {
  const a = pk(1)
  const pool = fakePool((relay, f) => (f.kinds.includes(10002) ? [list(pk(9), [['r', 'wss://evil.example']])] : []))
  await make(pool).getProfiles([a])
  assert.ok(!pool.calls.some((c) => c.relays.includes('wss://evil.example')))
})

test('sanitizeRelayUrl is exported and rejects private hosts', () => {
  assert.equal(sanitizeRelayUrl('wss://relay.damus.io/'), 'wss://relay.damus.io')
  assert.equal(sanitizeRelayUrl('wss://10.0.0.1'), null)
  assert.equal(sanitizeRelayUrl('wss://[::1]'), null)
  assert.equal(sanitizeRelayUrl('ws://relay.damus.io'), null)
})

test('getLikes: the next page starts where no relay that hit the limit could have left a gap', async () => {
  const reaction = (relay, t) => ({ kind: 7, pubkey: pk(1), created_at: t, content: '-', tags: [], id: `${relay}${t}`, sig: 'y' })
  const A = 'wss://deep.example', B = 'wss://dense.example'
  const pool = fakePool((relay, f) => {
    if (!f.kinds.includes(7)) return []
    const start = relay === A ? 1000 : 1100
    return Array.from({ length: f.limit }, (_, i) => reaction(relay, start + i))
  })
  const likes = await createFetcher({ relays: [A, B], pool }).getLikes(pk(1), { limit: 200 })
  assert.equal(likes.reactionCount, 400)
  // Relay B stopped at its limit at 1100; anything it holds below that was never sent.
  assert.ok(likes.nextUntil >= 1100, String(likes.nextUntil))
})
