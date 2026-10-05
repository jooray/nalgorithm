import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { openDb, createStore } from '../dist/db.js'
import { createFeedRunner, FeedBusy } from '../dist/feed.js'
import { DEFAULT_SETTINGS } from '../dist/settings.js'
import { configureWebSocket } from '../dist/websocket.js'

configureWebSocket()
const silent = { info() {}, warn() {} }
const settings = { ...DEFAULT_SETTINGS, userPrompt: 'x', learnFromLikes: false }

/** A relay that answers the follow list after `followDelayMs` and has no posts. */
async function startRelay(sk, followDelayMs = 0) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((r) => wss.once('listening', r))
  const reqs = []
  const follows = finalizeEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000), tags: [['p', 'b'.repeat(64)]], content: '' }, sk)
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    ws.on('message', (raw) => {
      const [type, id, ...filters] = JSON.parse(String(raw))
      if (type !== 'REQ') return
      reqs.push(filters)
      if (filters.some((f) => f.kinds?.includes(3))) {
        setTimeout(() => { ws.send(JSON.stringify(['EVENT', id, follows])); ws.send(JSON.stringify(['EOSE', id])) }, followDelayMs)
      } else ws.send(JSON.stringify(['EOSE', id]))
    })
  })
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    reqs,
    async close() { for (const ws of wss.clients) ws.terminate(); await new Promise((r) => wss.close(r)) },
  }
}

const configFor = (relay) => ({ relays: [relay.url], venice: { apiBaseUrl: 'http://127.0.0.1:1', apiKey: '', scoringModel: 'm', learnerModel: 'm' } })

test('feed runner: a busy claim costs nothing, a run is charged once, a repeat within two minutes is free', { timeout: 20000 }, async () => {
  const sk = generateSecretKey(); const npub = getPublicKey(sk)
  const relay = await startRelay(sk)
  const db = await openDb(':memory:')
  try {
    const feed = createFeedRunner(configFor(relay), silent, db)
    let charged = 0
    const charge = async () => { charged++ }
    await db.run('INSERT INTO pipeline_jobs (npub, owner, lease_until) VALUES (?, ?, ?)', [npub, 'elsewhere', Math.floor(Date.now() / 1000) + 600])
    await assert.rejects(feed(npub, settings, createStore(db, npub), undefined, false, charge), (e) => e instanceof FeedBusy)
    assert.equal(charged, 0, 'no unit for a run that never started')
    await db.run('DELETE FROM pipeline_jobs')
    await feed(npub, settings, createStore(db, npub), undefined, false, charge)
    assert.equal(charged, 1)
    await feed(npub, settings, createStore(db, npub), undefined, false, charge)
    assert.equal(charged, 1, 'the run that just finished answers, already paid for')
    await feed(npub, settings, createStore(db, npub), undefined, true, charge)
    assert.equal(charged, 2, 'a forced run is a new run')
  } finally { await db.close(); await relay.close() }
})

test('feed runner: a caller that joins a shared run keeps its own deadline, not the first caller\'s', { timeout: 20000 }, async () => {
  const sk = generateSecretKey(); const npub = getPublicKey(sk)
  const relay = await startRelay(sk, 400)
  const db = await openDb(':memory:')
  try {
    const feed = createFeedRunner(configFor(relay), silent, db)
    const short = new AbortController()
    const first = feed(npub, settings, createStore(db, npub), short.signal)
    const second = feed(npub, settings, createStore(db, npub), AbortSignal.timeout(15_000))
    setTimeout(() => short.abort(new Error('web request gave up')), 50)
    await assert.rejects(first, /web request gave up/)
    const result = await second
    assert.deepEqual(result.posts, [])
    assert.ok(relay.reqs.some((filters) => filters.some((f) => f.kinds?.includes(1))), 'the run went on to fetch posts after the first caller left')
  } finally { await db.close(); await relay.close() }
})
