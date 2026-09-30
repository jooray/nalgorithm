import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { configureWebSocket } from '../dist/websocket.js'
import { publishToRelays } from '../dist/dm/index.js'
import { startMockRelay } from './dm-mock-relay.mjs'

const sk = generateSecretKey()
const event = () => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: String(Math.random()) }, sk)
const fast = { timeoutMs: 400, sleep: async () => {} }
const DEAD = 'ws://127.0.0.1:1'

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
async function relay(mode) {
  const r = await startMockRelay({ ackMode: mode })
  relays.push(r)
  return r
}

test('an OK matched by event id marks the relay ok and the event delivered', async () => {
  const a = await relay('ok')
  const e = event()
  const res = await publishToRelays(pool, e, [a.url], fast)
  assert.equal(res.delivered, true)
  assert.equal(res.eventId, e.id)
  assert.deepEqual(res.relays[a.url], { status: 'ok' })
  assert.equal(a.events[0].id, e.id)
})

test('partial failure: one accepting relay is enough, a rejecting relay is not retried', async () => {
  const good = await relay('ok')
  const bad = await relay('reject')
  const res = await publishToRelays(pool, event(), [good.url, bad.url], fast)
  assert.equal(res.delivered, true)
  assert.equal(res.relays[good.url].status, 'ok')
  assert.deepEqual(res.relays[bad.url], { status: 'rejected', reason: 'blocked: test' })
  assert.equal(bad.attempts.length, 1, 'rejected is final')
})

test('every relay rejecting means not delivered', async () => {
  const bad = await relay('reject')
  const res = await publishToRelays(pool, event(), [bad.url], fast)
  assert.equal(res.delivered, false)
  assert.equal(bad.attempts.length, 1)
})

test('a silent relay is retried up to 3 attempts then reported as timeout', async () => {
  const slow = await relay('hang')
  const sleeps = []
  const res = await publishToRelays(pool, event(), [slow.url], { timeoutMs: 250, sleep: async (ms) => void sleeps.push(ms) })
  assert.equal(res.delivered, false)
  assert.equal(res.relays[slow.url].status, 'timeout')
  assert.equal(slow.attempts.length, 3)
  assert.deepEqual(sleeps, [500, 2000])
})

test('a transient failure that clears on retry ends up ok', async () => {
  const flaky = await relay('hang')
  const res = await publishToRelays(pool, event(), [flaky.url], {
    timeoutMs: 300,
    sleep: async () => {
      flaky.ackMode = 'ok'
    },
  })
  assert.equal(res.delivered, true)
  assert.equal(res.relays[flaky.url].status, 'ok')
  assert.ok(flaky.attempts.length >= 2)
})

test('a relay that drops the connection or is unreachable is an error, and other relays still count', async () => {
  const dropper = await relay('close')
  const good = await relay('ok')
  const res = await publishToRelays(pool, event(), [dropper.url, DEAD, good.url], fast)
  assert.equal(res.delivered, true)
  assert.equal(res.relays[dropper.url].status, 'error')
  assert.equal(res.relays[DEAD].status, 'error')
  assert.equal(res.relays[good.url].status, 'ok')
  assert.equal(good.attempts.length, 1, 'a relay that answered is not asked again')
})

test('no relays and duplicate relays are handled; at most 8 relays are used', async () => {
  const none = await publishToRelays(pool, event(), [], fast)
  assert.deepEqual(none, { delivered: false, eventId: none.eventId, relays: {} })
  const a = await relay('ok')
  const dup = await publishToRelays(pool, event(), [a.url, a.url], fast)
  assert.equal(Object.keys(dup.relays).length, 1)
  assert.equal(a.attempts.length, 1)

  const many = Array.from({ length: 12 }, (_, i) => `ws://127.0.0.1:${i + 1}`)
  const res = await publishToRelays(pool, event(), many, fast)
  assert.deepEqual(Object.keys(res.relays), many.slice(0, 8))
})
