import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { openDb, createStore, pruneScores, SCORE_TTL_SECONDS } from '../dist/db.js'
import { createApp } from '../dist/app.js'
import { loadFeedProfiles } from '../dist/feed.js'
import { createDigestNow } from '../dist/digest-jobs.js'
import { createJobTracker } from '../dist/drain.js'
import { trimSnapshot, flagNew, SNAPSHOT_FRESH_SECONDS } from '../dist/snapshot.js'
import * as nip19 from 'nostr-tools/nip19'
import { createBillingClient, BillingUnavailable } from '../dist/billing-client.js'
import { applySettings, DEFAULT_SETTINGS, SettingsError } from '../dist/settings.js'
import { issueChallenge, verifyLogin, AuthError } from '../dist/auth.js'

const PUBLIC = 'https://example.test/nalgorithm/api'
const LOGIN_URL = `${PUBLIC}/auth/login`
const T0 = 1_800_000_000
const silent = { info() {}, warn() {} }

// Set TEST_DATABASE_URL to run the whole suite against MariaDB instead of SQLite.
// One shared connection pool for the whole file, closed at the end: a pool per
// test would keep the process alive after the tests finish.
let shared
after(async () => {
  await shared?.close()
})
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['link_previews', 'peers', 'deliveries', 'digests', 'schedules', 'seen_wraps', 'feed_snapshots', 'digest_jobs', 'scores', 'learned', 'nonces', 'sessions', 'settings', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

function loginEvent(sk, { nonce, url = LOGIN_URL, method = 'POST', at = T0, kind = 27235 }) {
  return finalizeEvent({ kind, created_at: at, tags: [['u', url], ['method', method], ['nonce', nonce]], content: '' }, sk)
}

// ─── auth ────────────────────────────────────────────────────────────────────

test('login: a valid signed challenge yields the signer npub, once', async () => {
  const db = await freshDb()
  const sk = generateSecretKey()
  const { nonce } = await issueChallenge(db, T0)
  assert.equal(await verifyLogin(db, loginEvent(sk, { nonce }), LOGIN_URL, T0), getPublicKey(sk))
  // Replaying the same nonce fails.
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce }), LOGIN_URL, T0), AuthError)
})

test('login: rejects wrong URL, method, kind, stale time, unknown nonce and tampering', async () => {
  const db = await freshDb()
  const sk = generateSecretKey()
  const fresh = async () => (await issueChallenge(db, T0)).nonce
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce: await fresh(), url: 'https://evil.test/auth/login' }), LOGIN_URL, T0), /different URL/)
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce: await fresh(), method: 'GET' }), LOGIN_URL, T0), /different method/)
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce: await fresh(), kind: 1 }), LOGIN_URL, T0), /wrong event kind/)
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce: await fresh(), at: T0 - 600 }), LOGIN_URL, T0), /not fresh/)
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce: 'never-issued' }), LOGIN_URL, T0), /nonce/)
  const tampered = loginEvent(sk, { nonce: await fresh() })
  tampered.content = 'changed'
  await assert.rejects(verifyLogin(db, tampered, LOGIN_URL, T0), /bad signature/)
  await assert.rejects(verifyLogin(db, null, LOGIN_URL, T0), AuthError)
})

test('login: an expired nonce is rejected', async () => {
  const db = await freshDb()
  const sk = generateSecretKey()
  const { nonce } = await issueChallenge(db, T0)
  await assert.rejects(verifyLogin(db, loginEvent(sk, { nonce, at: T0 + 400 }), LOGIN_URL, T0 + 400), /nonce/)
})

// ─── store ───────────────────────────────────────────────────────────────────

test('store: scores are isolated per npub and respect the TTL', async () => {
  const db = await freshDb()
  const now = () => T0
  const a = createStore(db, 'a'.repeat(64), now)
  const b = createStore(db, 'b'.repeat(64), now)
  await a.putScores({ e1: { score: 8, justification: 'j', createdAt: T0 - 100, scorer: 'decision' }, old: { score: 3, createdAt: T0 - SCORE_TTL_SECONDS - 10 } })
  assert.deepEqual(await a.getScores(['e1', 'old', 'missing']), { e1: { score: 8, justification: 'j', createdAt: T0 - 100, scorer: 'decision' } })
  assert.deepEqual(await b.getScores(['e1']), {})
  assert.equal(await pruneScores(db, T0), 1)
})

test('store: learned prompt round trips and updates in place', async () => {
  const db = await freshDb()
  const s = createStore(db, 'a'.repeat(64), () => T0)
  assert.equal(await s.getLearned(), null)
  await s.putLearned({ prompt: 'p1', updatedAt: 't1', lastLikeTimestamp: 5 })
  await s.putLearned({ prompt: 'p2', updatedAt: 't2' })
  assert.deepEqual(await s.getLearned(), { prompt: 'p2', updatedAt: 't2' })
})

test('store: a large key list is queried in chunks', async () => {
  const db = await freshDb()
  const s = createStore(db, 'a'.repeat(64), () => T0)
  const entries = {}
  const keys = []
  for (let i = 0; i < 1300; i++) { keys.push(`k${i}`); entries[`k${i}`] = { score: i % 10, createdAt: T0 } }
  await s.putScores(entries)
  assert.equal(Object.keys(await s.getScores(keys)).length, 1300)
})

// ─── settings ────────────────────────────────────────────────────────────────

test('settings: validates every field and rejects unknown ones', async () => {
  const ok = applySettings(DEFAULT_SETTINGS, { userPrompt: '  bitcoin and nostr  ', hoursBack: 12, topN: 5, learnFromLikes: false, linkPreviews: false })
  assert.deepEqual(ok, { userPrompt: 'bitcoin and nostr', hoursBack: 12, topN: 5, learnFromLikes: false, linkPreviews: false })
  for (const bad of [{ hoursBack: 0 }, { hoursBack: 100 }, { topN: 1.5 }, { userPrompt: 5 }, { userPrompt: 'x'.repeat(2001) }, { learnFromLikes: 'yes' }, { linkPreviews: 'no' }, { apiKey: 'x' }, []]) {
    assert.throws(() => applySettings(DEFAULT_SETTINGS, bad), SettingsError, JSON.stringify(bad))
  }
})

// ─── billing client ──────────────────────────────────────────────────────────

function fakeBillingFetch(state) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body })
    if (state.down) throw new Error('connection refused')
    if (state.status && state.status !== 200) return new Response('{}', { status: state.status })
    if (url.includes('/v1/entitlement/')) return new Response(JSON.stringify({ products: { nalgorithm: state.product } }), { status: 200 })
    if (url.endsWith('/v1/trials')) return new Response('{}', { status: state.trialStatus ?? 200 })
    if (url.endsWith('/v1/consume')) return new Response(JSON.stringify(state.consume ?? { allowed: true, remaining: 9 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  return { fn, calls }
}

test('billing client: 60 s cache, stale-while-error for 24 h, then unknown', async () => {
  let t = T0
  const state = { product: { state: 'active', until: T0 + 10 * 86400 } }
  const { fn, calls } = fakeBillingFetch(state)
  const c = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: fn, now: () => t })
  assert.equal((await c.entitlement('n')).state, 'active')
  t += 30
  await c.entitlement('n')
  assert.equal(calls.length, 1, 'cached within 60 s')
  state.down = true
  t += 100
  assert.equal((await c.entitlement('n')).state, 'active', 'stale value served during an outage')
  t += 86_400
  assert.equal((await c.entitlement('n')).state, 'unknown', 'older than 24 h and unreachable')
  assert.equal((await c.entitlement('never-seen')).state, 'unknown')
})

test('billing client: stale data never grants past its own until', async () => {
  let t = T0
  const state = { product: { state: 'trial', until: T0 + 100 } }
  const { fn } = fakeBillingFetch(state)
  const c = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: fn, now: () => t })
  await c.entitlement('n')
  state.down = true
  t += 500
  assert.equal((await c.entitlement('n')).state, 'expired')
})

test('billing client: a circuit breaker limits calls during an outage', async () => {
  let t = T0
  const { fn, calls } = fakeBillingFetch({ down: true })
  const c = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: fn, now: () => t })
  await c.entitlement('a')
  await c.entitlement('b')
  await c.entitlement('c')
  assert.equal(calls.length, 1)
  t += 11
  await c.entitlement('d')
  assert.equal(calls.length, 2)
})

test('billing client: trial start treats 409 as success and re-reads the state', async () => {
  const state = { product: { state: 'none' }, trialStatus: 409 }
  const { fn } = fakeBillingFetch(state)
  const c = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: fn, now: () => T0 })
  assert.equal((await c.entitlement('n')).state, 'none')
  state.product = { state: 'trial', until: T0 + 100 }
  assert.equal((await c.startTrial('n')).state, 'trial')
})

test('billing client: consume on outage allows a known-active user and denies anyone else', async () => {
  const state = { product: { state: 'active', until: T0 + 1000 } }
  const { fn } = fakeBillingFetch(state)
  const c = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: fn, now: () => T0 })
  await c.entitlement('paid')
  const trialState = { product: { state: 'trial', until: T0 + 1000 } }
  const t2 = fakeBillingFetch(trialState)
  const c2 = createBillingClient({ url: 'http://b', token: 't', product: 'nalgorithm', fetch: t2.fn, now: () => T0 })
  await c2.entitlement('trialist')
  state.down = true
  trialState.down = true
  assert.equal((await c.consume('paid', 'feed', 1)).allowed, true)
  assert.deepEqual(await c2.consume('trialist', 'feed', 1), { allowed: false, reason: 'billing_unavailable' })
  assert.equal((await c.consume('stranger', 'feed', 1)).allowed, false)
})

// ─── HTTP ────────────────────────────────────────────────────────────────────

function fakeBilling(initial = { state: 'active', until: T0 + 86400 }) {
  const b = {
    current: initial,
    trials: [],
    consumed: [],
    consumeResult: { allowed: true },
    async entitlement() { if (b.current === 'throw') throw new BillingUnavailable('down'); return b.current },
    async startTrial(npub) { b.trials.push(npub); b.current = { state: 'trial', until: T0 + 3 * 86400 }; return b.current },
    async consume(npub, kind, units, key) { b.consumed.push({ npub, kind, units, key }); return b.consumeResult },
    async createCharge(npub, plan, sats) { b.charge = { npub, plan, sats }; return { invoice_id: 'inv1', checkout_url: 'https://pay/i/inv1' } },
    forget() {},
  }
  return b
}

async function withApp(fn, { billing = fakeBilling(), feed, runDigestNow, makeDigestNow, jobs, voiceSample, clock = { t: T0 } } = {}) {
  const db = await freshDb()
  const feedCalls = []
  const runner = feed ?? (async (npub, settings) => {
    feedCalls.push({ npub, settings })
    return {
      fetched: 3,
      profiles: { [npub]: { name: 'me' }, other: { name: 'not returned' } },
      posts: [
        { id: 'p1', type: 'original', author: npub, content: 'hello', createdAt: T0, score: 9, justification: 'good', rawEvent: { secret: 1 } },
        { id: 'p2', type: 'original', author: npub, content: 'low', createdAt: T0, score: 2, rawEvent: { secret: 1 } },
      ],
    }
  })
  const server = createServer(createApp({ db, billing, feed: runner, publicUrl: PUBLIC, secureCookie: false, log: silent, now: () => clock.t, runDigestNow: makeDigestNow ? makeDigestNow(db) : runDigestNow, jobs, voiceSample }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const sk = generateSecretKey()
  const npub = getPublicKey(sk)
  const json = (path, { method = 'GET', body, token } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  async function login() {
    const ch = await (await json('/auth/challenge', { method: 'POST', body: {} })).json()
    const res = await json('/auth/login', { method: 'POST', body: { event: loginEvent(sk, { nonce: ch.nonce }) } })
    return { res, body: await res.clone().json() }
  }
  try {
    await fn({ base, json, login, sk, npub, db, billing, feedCalls, clock })
  } finally {
    server.close()
  }
}

test('HTTP: login sets an HttpOnly SameSite cookie and returns a token; /me works with either', async () => {
  await withApp(async ({ json, login, npub }) => {
    const { res, body } = await login()
    assert.equal(res.status, 200)
    assert.equal(body.npub, npub)
    const cookie = res.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    assert.match(cookie, /Path=\/nalgorithm\/api/)
    assert.equal((await json('/me', { token: body.token })).status, 200)
    assert.equal((await json('/me')).status, 401)
    assert.equal((await json('/me', { token: 'x'.repeat(64) })).status, 401)
  })
})

test('HTTP: writes require a JSON content type', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/auth/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' })
    assert.equal(res.status, 415)
  })
})

test('HTTP: logout revokes the session', async () => {
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    assert.equal((await json('/auth/logout', { method: 'POST', body: {}, token: body.token })).status, 200)
    assert.equal((await json('/me', { token: body.token })).status, 401)
  })
})

test('HTTP: settings validate and persist per user', async () => {
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    assert.equal((await json('/settings', { method: 'PUT', body: { topN: 99 }, token: body.token })).status, 400)
    const ok = await (await json('/settings', { method: 'PUT', body: { userPrompt: 'nostr dev', topN: 7 }, token: body.token })).json()
    assert.equal(ok.topN, 7)
    assert.equal((await (await json('/settings', { token: body.token })).json()).userPrompt, 'nostr dev')
  })
})

test('HTTP: feed needs a prompt first', async () => {
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    const res = await json('/feed', { token: body.token })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'no_prompt')
  })
})

async function setPrompt(json, token) {
  await json('/settings', { method: 'PUT', body: { userPrompt: 'nostr' }, token })
}

test('HTTP: feed for an active user returns trimmed posts and only relevant profiles', async () => {
  await withApp(async ({ json, login, npub, billing, feedCalls }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    const res = await json('/feed?limit=1', { token: body.token })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.posts.length, 1)
    assert.equal(data.posts[0].id, 'p1')
    assert.equal('rawEvent' in data.posts[0], false)
    assert.deepEqual(Object.keys(data.profiles), [npub])
    assert.equal(billing.trials.length, 0)
    assert.deepEqual(billing.consumed[0].kind, 'feed')
    assert.equal(feedCalls[0].npub, npub)
  })
})

test('HTTP: profiles cover boosted, quoted and mentioned authors, and nobody else', async () => {
  const H = (c) => c.repeat(64)
  const mention = nip19.npubEncode(H('d'))
  const feed = async () => ({
    fetched: 2,
    profiles: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((c) => [H(c), { name: `n${c}` }])),
    posts: [
      { id: 'p1', type: 'boost', author: H('a'), content: '', createdAt: T0, score: 9, originalPost: { id: 'o', author: H('b'), content: `hi nostr:${mention}` } },
      { id: 'p2', type: 'quote', author: H('a'), content: 'q', createdAt: T0, score: 5, quotedPost: { id: 'q', author: H('c'), content: '' } },
    ],
  })
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    const data = await (await json('/feed', { token: body.token })).json()
    assert.deepEqual(Object.keys(data.profiles).sort(), [H('a'), H('b'), H('c'), H('d')])
  }, { feed })
})

test('loadFeedProfiles asks the fetcher for embedded and mentioned authors', async () => {
  const H = (c) => c.repeat(64)
  let asked
  const fetcher = { async getProfiles(pks) { asked = pks; return new Map() } }
  await loadFeedProfiles(fetcher, [
    { author: H('a'), content: '', originalPost: { author: H('b'), content: `x nostr:${nip19.npubEncode(H('d'))}` } },
  ])
  assert.deepEqual(asked, [H('a'), H('b'), H('d')])
  await loadFeedProfiles(fetcher, [{ author: H('a'), content: '', originalPost: { author: H('b'), content: '' } }], 1)
  assert.deepEqual(asked, [H('a')])
})

test('HTTP: a never-seen npub starts its trial on first feed use', async () => {
  await withApp(async ({ json, login, npub, billing }) => {
    billing.current = { state: 'none' }
    const { body } = await login()
    await setPrompt(json, body.token)
    assert.equal((await json('/me', { token: body.token })).status, 200)
    assert.equal(billing.trials.length, 0, 'login and /me do not start a trial')
    const res = await json('/feed', { token: body.token })
    assert.equal(res.status, 200)
    assert.deepEqual(billing.trials, [npub])
  })
})

test('HTTP: expired gets 402, unknown gets 503, and neither runs the feed', async () => {
  await withApp(async ({ json, login, billing, feedCalls }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    billing.current = { state: 'expired', until: T0 - 5 }
    let res = await json('/feed', { token: body.token })
    assert.equal(res.status, 402)
    assert.equal((await res.json()).code, 'paywall')
    billing.current = 'throw'
    res = await json('/feed', { token: body.token })
    assert.equal(res.status, 503)
    assert.equal(feedCalls.length, 0)
    assert.equal((await json('/settings', { token: body.token })).status, 200, 'free endpoints survive a billing outage')
  })
})

test('HTTP: the daily cap answers 429 and a consume outage answers 503, without running the feed', async () => {
  await withApp(async ({ json, login, billing, feedCalls }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    billing.consumeResult = { allowed: false, reason: 'cap_reached' }
    let res = await json('/feed', { token: body.token })
    assert.equal(res.status, 429)
    assert.equal((await res.json()).code, 'daily_cap')
    billing.consumeResult = { allowed: false, reason: 'billing_unavailable' }
    res = await json('/feed', { token: body.token })
    assert.equal(res.status, 503)
    assert.equal(feedCalls.length, 0)
  })
})

test('HTTP: a second concurrent feed run for the same npub is refused', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    const first = json('/feed', { token: body.token })
    await new Promise((r) => setTimeout(r, 50))
    const second = await json('/feed', { token: body.token })
    assert.equal(second.status, 429)
    assert.equal((await second.json()).code, 'in_progress')
    release()
    assert.equal((await first).status, 200)
  }, { feed: async () => { await gate; return { fetched: 0, profiles: {}, posts: [] } } })
})

// ─── feed snapshots ──────────────────────────────────────────────────────────

test('snapshot: /feed saves the ranking and /feed/latest returns it with its age, never ranking or consuming', async () => {
  const clock = { t: T0 }
  await withApp(async ({ json, login, npub, billing, feedCalls, db }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    let res = await json('/feed/latest', { token: body.token })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).snapshot, null)

    const run = await (await json('/feed', { token: body.token })).json()
    assert.equal(run.cached, false)
    assert.equal(run.ageSeconds, 0)
    assert.equal(billing.consumed.length, 1)
    const row = await db.get('SELECT created_at, json FROM feed_snapshots WHERE npub = ?', [npub])
    assert.equal(Number(row.created_at), T0)
    assert.equal(JSON.parse(row.json).posts.length, 2)
    assert.equal('rawEvent' in JSON.parse(row.json).posts[0], false)

    clock.t = T0 + 300
    res = await json('/feed/latest', { token: body.token })
    const data = await res.json()
    assert.equal(data.snapshot.ageSeconds, 300)
    assert.equal(data.snapshot.posts.length, 2)
    assert.equal(data.snapshot.posts.every((p) => p.isNew === false), true)
    assert.deepEqual(Object.keys(data.snapshot.profiles), [npub])
    assert.equal(data.entitlement.state, 'active')
    assert.equal(data.snapshot.settingsChanged, false)
    assert.equal(feedCalls.length, 1, 'latest never runs the feed')
    assert.equal(billing.consumed.length, 1, 'latest never consumes the cap')

    const unchanged = await (await json(`/feed/latest?since=${T0}`, { token: body.token })).json()
    assert.equal(unchanged.unchanged, true, 'a client that has this ranking gets no posts back')
    assert.equal(unchanged.snapshot, null)
    assert.equal(unchanged.settingsChanged, false)
    assert.equal((await (await json(`/feed/latest?since=${T0 - 1}`, { token: body.token })).json()).snapshot.posts.length, 2)
  }, { clock })
})

test('snapshot: /feed/latest follows the paywall and billing rules, and never starts a trial', async () => {
  await withApp(async ({ json, login, billing }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    await json('/feed', { token: body.token })
    billing.current = { state: 'expired', until: T0 - 5 }
    let res = await json('/feed/latest', { token: body.token })
    assert.equal(res.status, 402)
    assert.equal((await res.json()).code, 'paywall')
    billing.current = 'throw'
    res = await json('/feed/latest', { token: body.token })
    assert.equal(res.status, 503)
    billing.current = { state: 'none' }
    res = await json('/feed/latest', { token: body.token })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).snapshot, null)
    assert.equal(billing.trials.length, 0)
    assert.equal((await json('/feed/latest')).status, 401)
  })
})

test('snapshot: isNew flags posts that were not in the previous snapshot', async () => {
  const clock = { t: T0 }
  let round = 0
  const feed = async (npub) => {
    round++
    const base = [{ id: 'p1', type: 'original', author: npub, content: 'a', createdAt: T0, score: 9 }]
    if (round > 1) base.push({ id: 'p2', type: 'original', author: npub, content: 'b', createdAt: T0, score: 5 })
    return { fetched: base.length, profiles: {}, posts: base }
  }
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    const first = await (await json('/feed', { token: body.token })).json()
    assert.deepEqual(first.posts.map((p) => p.isNew), [false], 'no previous snapshot: nothing is new')
    clock.t = T0 + 600
    const second = await (await json('/feed', { token: body.token })).json()
    assert.deepEqual(second.posts.map((p) => [p.id, p.isNew]), [['p1', false], ['p2', true]])
    clock.t = T0 + 1200
    const third = await (await json('/feed', { token: body.token })).json()
    assert.equal(third.posts.every((p) => p.isNew === false), true)
  }, { feed, clock })
})

test('snapshot: a snapshot under two minutes old is served instead of a rerun, unless forced', async () => {
  const clock = { t: T0 }
  await withApp(async ({ json, login, billing, feedCalls }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    await json('/feed', { token: body.token })
    clock.t = T0 + SNAPSHOT_FRESH_SECONDS - 1
    const again = await (await json('/feed', { token: body.token })).json()
    assert.equal(again.cached, true)
    assert.equal(again.ageSeconds, SNAPSHOT_FRESH_SECONDS - 1)
    assert.equal(feedCalls.length, 1)
    assert.equal(billing.consumed.length, 1, 'a served snapshot costs nothing')
    const forced = await (await json('/feed?force=1', { token: body.token })).json()
    assert.equal(forced.cached, false)
    assert.equal(feedCalls.length, 2)
    clock.t += SNAPSHOT_FRESH_SECONDS
    assert.equal((await (await json('/feed', { token: body.token })).json()).cached, false)
    assert.equal(feedCalls.length, 3)
    // Changed settings make a young snapshot stale.
    await json('/settings', { method: 'PUT', body: { userPrompt: 'something else' }, token: body.token })
    const changed = await (await json('/feed/latest', { token: body.token })).json()
    assert.equal(changed.snapshot.settingsChanged, true)
    clock.t += 5
    assert.equal((await (await json('/feed', { token: body.token })).json()).cached, false)
    assert.equal(feedCalls.length, 4)
  }, { clock })
})

test('snapshot: the guard does not bypass the paywall', async () => {
  await withApp(async ({ json, login, billing }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    await json('/feed', { token: body.token })
    billing.current = { state: 'expired', until: T0 - 5 }
    assert.equal((await json('/feed', { token: body.token })).status, 402)
  })
})

test('snapshot: a capped run leaves the stored snapshot readable', async () => {
  const clock = { t: T0 }
  await withApp(async ({ json, login, billing }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    await json('/feed', { token: body.token })
    clock.t = T0 + 900
    billing.consumeResult = { allowed: false, reason: 'cap_reached' }
    assert.equal((await json('/feed', { token: body.token })).status, 429)
    const latest = await (await json('/feed/latest', { token: body.token })).json()
    assert.equal(latest.snapshot.posts.length, 2)
  }, { clock })
})

test('snapshot: trimSnapshot drops the lowest-ranked posts and the profiles only they needed', () => {
  const H = (c) => c.repeat(64)
  const posts = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, type: 'original', author: i < 20 ? H('a') : H('b'), content: 'x'.repeat(1000), createdAt: T0, score: 40 - i }))
  const snap = { posts, profiles: { [H('a')]: { name: 'a' }, [H('b')]: { name: 'b' } }, fetched: 40, hoursBack: 24, sig: 's' }
  const out = trimSnapshot(snap, 15_000)
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 15_000)
  assert.ok(out.posts.length > 0 && out.posts.length < 40)
  assert.deepEqual(out.posts.map((p) => p.id), posts.slice(0, out.posts.length).map((p) => p.id))
  assert.deepEqual(Object.keys(out.profiles), [H('a')])
  assert.equal(trimSnapshot(snap), snap, 'under the bound nothing changes')
})

test('snapshot: flagNew with no previous snapshot marks nothing', () => {
  assert.deepEqual(flagNew([{ id: 'a' }], null), [{ id: 'a', isNew: false }])
})

// ─── digest slot ─────────────────────────────────────────────────────────────

test('HTTP: two simultaneous digest requests make exactly one digest; the second gets 409 with the start time', async () => {
  const clock = { t: T0 }
  let release
  const gate = new Promise((r) => { release = r })
  const runs = []
  await withApp(async ({ json, login, clock: c, db }) => {
    const { body } = await login()
    const status0 = await (await json('/digest/status', { token: body.token })).json()
    assert.deepEqual(status0, { running: false, startedAt: null, lastDurationSeconds: null, lastStatus: null, finishedAt: null })

    const [a, b] = await Promise.all([
      json('/digest/now', { method: 'POST', body: {}, token: body.token }),
      json('/digest/now', { method: 'POST', body: {}, token: body.token }),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [202, 409])
    const loser = await (a.status === 409 ? a : b).json()
    assert.equal(loser.code, 'digest_running')
    assert.equal(loser.startedAt, T0)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(runs.length, 1)

    const running = await (await json('/digest/status', { token: body.token })).json()
    assert.equal(running.running, true)
    assert.equal(running.startedAt, T0)
    assert.equal((await json('/digest/now', { method: 'POST', body: {}, token: body.token })).status, 409, 'still blocked while running')

    c.t = T0 + 95
    release()
    await new Promise((r) => setTimeout(r, 50))
    const done = await (await json('/digest/status', { token: body.token })).json()
    assert.equal(done.running, false)
    assert.equal(done.lastStatus, 'sent')
    assert.equal(done.lastDurationSeconds, 95)
    assert.equal((await json('/digest/now', { method: 'POST', body: {}, token: body.token })).status, 202, 'free again after it finishes')
    release()
  }, {
    clock,
    makeDigestNow: (db) => createDigestNow({
      db,
      log: silent,
      now: () => clock.t,
      run: async (n) => { runs.push(n); await gate; return { status: 'sent' } },
    }),
  })
})

test('digest slot: a stale claim can be taken over, a failed run keeps the old duration, restart marks running rows interrupted', async () => {
  const { claimDigestJob, finishDigestJob, digestJobStatus, interruptRunningJobs, DIGEST_JOB_STALE_SECONDS } = await import('../dist/digest-jobs.js')
  const db = await freshDb()
  const n = 'a'.repeat(64)
  const first = await claimDigestJob(db, n, T0)
  assert.equal(first.claimed, true); assert.equal(first.startedAt, T0); assert.equal(first.owner.length, 32)
  assert.deepEqual(await claimDigestJob(db, n, T0 + 5), { claimed: false, startedAt: T0 })
  await finishDigestJob(db, n, T0, 'sent', T0 + 60)
  let st = await digestJobStatus(db, n, T0 + 61)
  assert.equal(st.lastDurationSeconds, 60)
  assert.equal((await claimDigestJob(db, n, T0 + 100)).claimed, true)
  await finishDigestJob(db, n, T0 + 100, 'failed', T0 + 110)
  st = await digestJobStatus(db, n, T0 + 111)
  assert.deepEqual([st.running, st.lastStatus, st.lastDurationSeconds], [false, 'failed', 60])
  // A crashed claim goes stale and is reported as not running.
  await claimDigestJob(db, n, T0 + 200)
  assert.equal((await digestJobStatus(db, n, T0 + 201)).running, true)
  assert.equal((await digestJobStatus(db, n, T0 + 200 + DIGEST_JOB_STALE_SECONDS)).running, false)
  assert.equal((await claimDigestJob(db, n, T0 + 200 + DIGEST_JOB_STALE_SECONDS)).claimed, true)
  // A late finish from the dead run must not free the new claim.
  await finishDigestJob(db, n, T0 + 200, 'sent', T0 + 900)
  assert.equal((await digestJobStatus(db, n, T0 + 901)).running, true)
  assert.equal(await interruptRunningJobs(db, T0 + 1000), 0, 'startup must preserve another process\'s fresh lease')
  assert.equal(await interruptRunningJobs(db, T0 + 1500), 1)
  st = await digestJobStatus(db, n, T0 + 1501)
  assert.deepEqual([st.running, st.lastStatus], [false, 'interrupted'])
})

test('drain: waits for running jobs, refuses new ones after stop, and gives up at the timeout', async () => {
  const jobs = createJobTracker()
  const endA = jobs.begin()
  const endB = jobs.begin()
  assert.equal(jobs.active, 2)
  jobs.stop()
  assert.equal(jobs.stopping, true)
  assert.throws(() => jobs.begin(), /restarting/)
  let drained
  const waiting = jobs.drain(2000).then((v) => { drained = v })
  endA()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(drained, undefined, 'one job is still running')
  endB()
  endB()
  await waiting
  assert.equal(drained, true)
  assert.equal(jobs.active, 0)

  const stuck = createJobTracker()
  stuck.begin()
  assert.equal(await stuck.drain(30), false)
  assert.equal(await createJobTracker().drain(30), true, 'nothing running drains at once')
})

test('drain: the digest request and /feed refuse new work while shutting down', async () => {
  const jobs = createJobTracker()
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    await setPrompt(json, body.token)
    jobs.stop()
    const feed = await json('/feed', { token: body.token })
    assert.equal(feed.status, 503)
    assert.equal((await feed.json()).code, 'shutting_down')
    assert.equal((await json('/feed/latest', { token: body.token })).status, 200, 'reading a snapshot still works')
  }, { jobs })
})

test('HTTP: checkout uses the session npub, allowlists plans, and never takes an npub from the body', async () => {
  await withApp(async ({ json, login, npub, billing }) => {
    const { body } = await login()
    const res = await json('/billing/checkout', { method: 'POST', body: { plan: 'nalgorithm', npub: 'c'.repeat(64) }, token: body.token })
    assert.equal(res.status, 200)
    assert.deepEqual(billing.charge, { npub, plan: 'nalgorithm', sats: undefined })
    assert.equal((await json('/billing/checkout', { method: 'POST', body: { plan: 'lievik' }, token: body.token })).status, 400)
    assert.equal((await json('/billing/checkout', { method: 'POST', body: { plan: 'nalgorithm', sats: 1.5 }, token: body.token })).status, 400)
  })
})

test('HTTP: schedule read, validated update, and the next run is computed', async () => {
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    const before = await (await json('/schedule', { token: body.token })).json()
    assert.equal(before.enabled, false); assert.equal(before.tz, 'UTC')
    const ok = await (await json('/schedule', { method: 'PUT', body: { time: '07:30', tz: 'Europe/Bratislava', enabled: true, voice: 'af_bella' }, token: body.token })).json()
    assert.equal(ok.time, '07:30'); assert.equal(ok.enabled, true); assert.equal(ok.voice, 'af_bella'); assert.ok(ok.nextRunAt > T0)
    for (const bad of [{ time: '25:00' }, { tz: 'Mars/Base' }, { voice: 'BAD!' }, { dmFormat: 'nip99' }, { enabled: 'yes' }, { apiKey: 'x' }]) {
      assert.equal((await json('/schedule', { method: 'PUT', body: bad, token: body.token })).status, 400, JSON.stringify(bad))
    }
    assert.equal((await (await json('/schedule', { token: body.token })).json()).time, '07:30', 'a rejected update changes nothing')
    assert.equal((await json('/schedule')).status, 401)
  })
})

test('HTTP: digests list is per user and newest first; digest/now needs a runner', async () => {
  await withApp(async ({ json, login, npub, db }) => {
    const { body } = await login()
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status) VALUES (?, ?, ?, ?, ?)', [npub, T0 - 100, 'old', null, 'ok'])
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status) VALUES (?, ?, ?, ?, ?)', [npub, T0 - 10, 'new', 'https://x/y.mp3', 'ok'])
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status) VALUES (?, ?, ?, ?, ?)', ['f'.repeat(64), T0, 'someone else', null, 'ok'])
    const list = (await (await json('/digests', { token: body.token })).json()).digests
    assert.deepEqual(list.map((d) => d.text), ['new', 'old']); assert.equal(list[0].audioUrl, 'https://x/y.mp3')
    assert.equal((await json('/digest/now', { method: 'POST', body: {}, token: body.token })).status, 503)
  })
  const asked = []
  await withApp(async ({ json, login, npub }) => {
    const { body } = await login()
    const res = await json('/digest/now', { method: 'POST', body: {}, token: body.token })
    assert.equal(res.status, 202)
    assert.equal((await res.json()).message, 'queued')
    assert.deepEqual(asked, [npub], 'runs for the session npub, never one from the request')
  }, { runDigestNow: async (npub) => { asked.push(npub); return 'queued' } })
})

test('HTTP: a summary list leaves out notes, and an unchanged list answers 304 with no body', async () => {
  await withApp(async ({ base, login, npub, db }) => {
    const { body } = await login()
    const auth = { Authorization: `Bearer ${body.token}` }
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, notes) VALUES (?, ?, ?, ?, ?, ?)', [npub, T0 - 10, 'one', null, 'ok', JSON.stringify([{ id: 'n'.repeat(64), pubkey: npub }])])
    const full = await fetch(base + '/digests', { headers: auth })
    assert.equal((await full.json()).digests[0].notes.length, 1)
    const first = await fetch(base + '/digests?summary=1', { headers: auth })
    const etag = first.headers.get('etag')
    assert.ok(etag)
    assert.equal('notes' in (await first.json()).digests[0], false)
    const again = await fetch(base + '/digests?summary=1', { headers: { ...auth, 'If-None-Match': etag } })
    assert.equal(again.status, 304)
    assert.equal(await again.text(), '')
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status) VALUES (?, ?, ?, ?, ?)', [npub, T0, 'two', null, 'ok'])
    const changed = await fetch(base + '/digests?summary=1', { headers: { ...auth, 'If-None-Match': etag } })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).digests.length, 2)
  })
})

test('HTTP: voice samples are a fixed shortlist, made once per voice, and failures are not cached', async () => {
  const made = []
  let fail = true
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    assert.equal((await json('/voices/af_bella/sample')).status, 401)
    assert.equal((await json('/voices/af_bella/sample', { token: body.token })).status, 503, 'a failed sample says so')
    const first = await json('/voices/af_bella/sample', { token: body.token })
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('content-type'), 'audio/mpeg')
    assert.equal((await first.arrayBuffer()).byteLength, 3)
    assert.equal((await json('/voices/af_bella/sample', { token: body.token })).status, 200)
    assert.deepEqual(made, ['af_bella', 'af_bella'], 'one failed and one good call; the third answer came from memory')
    assert.equal((await json('/voices/af_nicole/sample', { token: body.token })).status, 404, 'voices off the shortlist cost nothing')
  }, { voiceSample: async (voice) => { made.push(voice); if (fail) { fail = false; throw new Error('tts down') } return new Uint8Array([1, 2, 3]) } })
  await withApp(async ({ json, login }) => {
    const { body } = await login()
    assert.equal((await json('/voices/af_bella/sample', { token: body.token })).status, 503)
  })
})

test('HTTP: digests carry the exact audio length, null for older rows', async () => {
  await withApp(async ({ json, login, npub, db }) => {
    const { body } = await login()
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, duration_s) VALUES (?, ?, ?, ?, ?, ?)', [npub, T0 - 100, 'old', 'https://x/a.mp3', 'ok', null])
    const id = (await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, duration_s) VALUES (?, ?, ?, ?, ?, ?)', [npub, T0 - 10, 'new', 'https://x/b.mp3', 'ok', 227.448])).lastInsertId
    const list = (await (await json('/digests', { token: body.token })).json()).digests
    assert.deepEqual(list.map((d) => d.durationSeconds), [227.448, null])
    assert.equal((await (await json(`/digests/${id}`, { token: body.token })).json()).durationSeconds, 227.448)
  })
})

test('HTTP: digests carry their notes (empty for old rows); GET /digests/:id is per user', async () => {
  await withApp(async ({ json, login, npub, db }) => {
    const { body } = await login()
    const notes = [{ id: 'c'.repeat(64), pubkey: 'd'.repeat(64), createdAt: T0 - 5, content: 'hi', score: 8, reason: 'because' }]
    const insert = (who, at, text, n) => db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, notes) VALUES (?, ?, ?, ?, ?, ?)', [who, at, text, null, 'ok', n])
    const old = (await insert(npub, T0 - 100, 'old', null)).lastInsertId
    const fresh = (await insert(npub, T0 - 10, 'new', JSON.stringify(notes))).lastInsertId
    const theirs = (await insert('f'.repeat(64), T0, 'theirs', JSON.stringify(notes))).lastInsertId
    const list = (await (await json('/digests', { token: body.token })).json()).digests
    assert.deepEqual(list.map((d) => d.notes), [notes, []])
    assert.deepEqual(await (await json(`/digests/${fresh}`, { token: body.token })).json(), { id: fresh, createdAt: T0 - 10, text: 'new', audioUrl: null, notes, durationSeconds: null })
    assert.deepEqual((await (await json(`/digests/${old}`, { token: body.token })).json()).notes, [])
    assert.equal((await json(`/digests/${theirs}`, { token: body.token })).status, 404, 'not the caller\'s')
    assert.equal((await json('/digests/999999', { token: body.token })).status, 404)
    assert.equal((await json('/digests/abc', { token: body.token })).status, 404)
    assert.equal((await json(`/digests/${fresh}`)).status, 401)
  })
})
