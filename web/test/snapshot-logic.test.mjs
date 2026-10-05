import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_AFTER_SECONDS,
  TOP_SCROLL_PX,
  ageLabel,
  clearLocalSnapshot,
  countNew,
  decideMerge,
  freshIds,
  isStale,
  loadLocalSnapshot,
  pillLabel,
  quietNotice,
  saveLocalSnapshot,
  shouldAutoRun,
  splitFresh,
  trimLocalSnapshot,
} from '../src/snapshot-logic.ts'

const NOW = 1_800_000_000

// ─── staleness label ─────────────────────────────────────────────────────────

test('ageLabel: just now, minutes, hours, days, and nothing without a snapshot', () => {
  assert.equal(ageLabel(null, NOW), '')
  assert.equal(ageLabel(NOW - 20, NOW), 'Updated just now')
  assert.equal(ageLabel(NOW - 60, NOW), 'Updated 1 min ago')
  assert.equal(ageLabel(NOW - 59 * 60, NOW), 'Updated 59 min ago')
  assert.equal(ageLabel(NOW - 3600, NOW), 'Updated 1 h ago')
  assert.equal(ageLabel(NOW - 47 * 3600, NOW), 'Updated 47 h ago')
  assert.equal(ageLabel(NOW - 72 * 3600, NOW), 'Updated 3 d ago')
  assert.equal(ageLabel(NOW + 500, NOW), 'Updated just now', 'a clock a little ahead is not negative')
})

test('isStale: ten minutes, absent, or changed settings', () => {
  assert.equal(isStale(NOW - STALE_AFTER_SECONDS + 1, NOW), false)
  assert.equal(isStale(NOW - STALE_AFTER_SECONDS, NOW), true)
  assert.equal(isStale(null, NOW), true)
  assert.equal(isStale(NOW - 5, NOW, true), true)
})

// ─── when to run by itself ───────────────────────────────────────────────────

const due = { enabled: true, ready: true, running: false, hidden: false, createdAt: NOW - 3600, nowSec: NOW }

test('shouldAutoRun: a stale or missing snapshot runs', () => {
  assert.equal(shouldAutoRun(due), true)
  assert.equal(shouldAutoRun({ ...due, createdAt: null }), true)
})

test('shouldAutoRun: a fresh snapshot does not', () => {
  assert.equal(shouldAutoRun({ ...due, createdAt: NOW - 120 }), false)
})

test('shouldAutoRun: changed settings make a fresh snapshot due', () => {
  assert.equal(shouldAutoRun({ ...due, createdAt: NOW - 30, settingsChanged: true }), true)
})

test('shouldAutoRun: never while disabled, not ready (paywall, no prompt, no key), running, or in the background', () => {
  assert.equal(shouldAutoRun({ ...due, enabled: false }), false)
  assert.equal(shouldAutoRun({ ...due, ready: false }), false)
  assert.equal(shouldAutoRun({ ...due, running: true }), false)
  assert.equal(shouldAutoRun({ ...due, hidden: true }), false)
})

test('shouldAutoRun: waits out a pause after a cap or outage, and after a failure that needs the reader', () => {
  assert.equal(shouldAutoRun({ ...due, pausedUntil: NOW + 1 }), false)
  assert.equal(shouldAutoRun({ ...due, pausedUntil: NOW }), true)
  assert.equal(shouldAutoRun({ ...due, attemptFailed: true }), false)
})

// ─── merge decision ──────────────────────────────────────────────────────────

const ids = (...a) => a
const base = { feedVisible: true, scrollY: 0 }

test('decideMerge: nothing on screen yet draws the result', () => {
  assert.deepEqual(decideMerge({ ...base, shownIds: [], incomingIds: ids('a', 'b') }), { action: 'render', newCount: 2, same: false })
})

test('decideMerge: an identical list changes nothing', () => {
  assert.deepEqual(decideMerge({ ...base, scrollY: 900, shownIds: ids('a', 'b'), incomingIds: ids('a', 'b') }), { action: 'keep', newCount: 0, same: true })
})

test('decideMerge: at the top the new list replaces the old silently, in rank order', () => {
  const d = decideMerge({ ...base, scrollY: TOP_SCROLL_PX, shownIds: ids('a', 'b'), incomingIds: ids('c', 'a', 'b') })
  assert.deepEqual(d, { action: 'merge', newCount: 1, same: false })
})

test('decideMerge: mid-scroll the reader gets a pill with the count and the list is not touched', () => {
  const d = decideMerge({ ...base, scrollY: TOP_SCROLL_PX + 1, shownIds: ids('a', 'b'), incomingIds: ids('c', 'd', 'a', 'b') })
  assert.deepEqual(d, { action: 'pill', newCount: 2, same: false })
})

test('decideMerge: mid-scroll with only a re-rank or dropped notes waits for the next open', () => {
  assert.equal(decideMerge({ ...base, scrollY: 600, shownIds: ids('a', 'b'), incomingIds: ids('b', 'a') }).action, 'keep')
  assert.equal(decideMerge({ ...base, scrollY: 600, shownIds: ids('a', 'b'), incomingIds: ids('a') }).action, 'keep')
})

test('decideMerge: the button replaces the list wherever the reader is', () => {
  assert.equal(decideMerge({ ...base, scrollY: 2000, manual: true, shownIds: ids('a'), incomingIds: ids('b', 'a') }).action, 'merge')
})

test('decideMerge: another tab on screen means nobody is mid-scroll in the feed', () => {
  assert.equal(decideMerge({ feedVisible: false, scrollY: 2000, shownIds: ids('a'), incomingIds: ids('b', 'a') }).action, 'merge')
})

test('countNew and pillLabel: each new id once, singular and plural', () => {
  assert.equal(countNew(ids('a'), ids('a', 'b', 'b', 'c')), 2)
  assert.equal(pillLabel(1), '1 new note')
  assert.equal(pillLabel(7), '7 new notes')
})

// ─── quiet notices ───────────────────────────────────────────────────────────

test('quietNotice: cap, outage and offline are one quiet line; sign-in and paywall are not', () => {
  assert.match(quietNotice(429, 'daily_cap').text, /Daily limit/)
  assert.equal(quietNotice(429, 'daily_cap').pauseSeconds, 3600)
  assert.match(quietNotice(503, 'billing_unavailable').text, /unavailable/)
  assert.match(quietNotice(0, 'network').text, /Offline/)
  assert.equal(quietNotice(429, 'in_progress').text, '', 'another run in progress says nothing')
  assert.equal(quietNotice(401), null)
  assert.equal(quietNotice(402, 'paywall'), null)
  assert.equal(quietNotice(400, 'no_prompt'), null)
})

// ─── storage ─────────────────────────────────────────────────────────────────

function fakeStore(limit = Infinity) {
  const m = new Map()
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      if (v.length > limit) throw new Error('QuotaExceededError')
      m.set(k, v)
    },
    removeItem: (k) => void m.delete(k),
  }
}

const snap = (n, extra = 0) => ({
  v: 1,
  createdAt: NOW,
  hoursBack: 24,
  posts: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, author: i < n / 2 ? 'a' : 'b', content: 'x'.repeat(extra) })),
  profiles: { a: { name: 'A' }, b: { name: 'B' } },
})

test('storage: a snapshot round-trips, is keyed, and is cleared', () => {
  const st = fakeStore()
  assert.equal(saveLocalSnapshot(st, 'k1', snap(3)), true)
  assert.deepEqual(loadLocalSnapshot(st, 'k1').posts.map((p) => p.id), ['p0', 'p1', 'p2'])
  assert.equal(loadLocalSnapshot(st, 'k2'), null, 'another key is another person')
  clearLocalSnapshot(st, 'k1')
  assert.equal(loadLocalSnapshot(st, 'k1'), null)
})

test('storage: blocked, corrupt or foreign data reads as no snapshot, and a refused write is not fatal', () => {
  assert.equal(loadLocalSnapshot(null, 'k'), null)
  assert.equal(saveLocalSnapshot(null, 'k', snap(1)), false)
  const st = fakeStore()
  st.m.set('bad', '{nope')
  st.m.set('old', JSON.stringify({ v: 2, createdAt: 1, posts: [], profiles: {} }))
  st.m.set('shape', JSON.stringify({ v: 1, createdAt: 'x', posts: [], profiles: {} }))
  assert.equal(loadLocalSnapshot(st, 'bad'), null)
  assert.equal(loadLocalSnapshot(st, 'old'), null)
  assert.equal(loadLocalSnapshot(st, 'shape'), null)
  const full = fakeStore(10)
  full.m.set('k', 'previous')
  assert.equal(saveLocalSnapshot(full, 'k', snap(3)), false)
  assert.equal(full.m.has('k'), false, 'a half-written or stale entry is removed')
})

test('storage: oversize snapshots lose the lowest-ranked posts and the profiles only those needed', () => {
  const big = snap(40, 1000)
  const out = trimLocalSnapshot(big, 12_000, 200, (posts) => new Set(posts.map((p) => p.author)))
  assert.ok(JSON.stringify(out).length <= 12_000)
  assert.ok(out.posts.length > 0 && out.posts.length < 40)
  assert.deepEqual(out.posts.map((p) => p.id), big.posts.slice(0, out.posts.length).map((p) => p.id))
  assert.deepEqual(Object.keys(out.profiles), ['a'])
  assert.equal(trimLocalSnapshot(snap(300), 1e9, 200).posts.length, 200, 'a post count cap applies too')
})

// ─── new since last refresh ──────────────────────────────────────────────────

test('freshIds: the notes a run added, in rank order', () => {
  assert.deepEqual(freshIds(['a', 'b', 'c'], ['x', 'a', 'y', 'b']), ['x', 'y'])
})

test('freshIds: nothing to set apart on a first draw or when everything is new', () => {
  assert.deepEqual(freshIds([], ['a', 'b']), [])
  assert.deepEqual(freshIds(['a'], ['x', 'y'], ['a']), [])
})

test('freshIds: a run with nothing new keeps what was new before, if still there', () => {
  assert.deepEqual(freshIds(['a', 'x', 'y'], ['y', 'a', 'x'], ['x', 'y', 'gone']), ['y', 'x'])
  assert.deepEqual(freshIds(['a', 'b'], ['b', 'a'], []), [])
})

test('freshIds: new notes replace the earlier new set', () => {
  assert.deepEqual(freshIds(['a', 'x'], ['z', 'x', 'a'], ['x']), ['z'])
})

test('splitFresh: fresh first, the rest after, both in rank order', () => {
  const posts = ['a', 'x', 'b', 'y'].map((id) => ({ id }))
  const r = splitFresh(posts, new Set(['y', 'x']))
  assert.deepEqual(r.fresh.map((p) => p.id), ['x', 'y'])
  assert.deepEqual(r.rest.map((p) => p.id), ['a', 'b'])
})

test('splitFresh: no split when nothing or everything is fresh', () => {
  const posts = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(splitFresh(posts, new Set()), { fresh: [], rest: posts })
  assert.deepEqual(splitFresh(posts, new Set(['a', 'b'])), { fresh: [], rest: posts })
  assert.deepEqual(splitFresh(posts, new Set(['gone'])), { fresh: [], rest: posts })
})

test('a stored snapshot keeps its fresh ids', () => {
  const mem = new Map()
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }
  saveLocalSnapshot(store, 'k', { v: 1, createdAt: NOW, fresh: ['x'], posts: [{ id: 'x' }, { id: 'a' }], profiles: {} })
  assert.deepEqual(loadLocalSnapshot(store, 'k').fresh, ['x'])
})

test('coverageText: says what was ranked, from which window, in which order, and when the window was capped', async () => {
  const { coverageText } = await import('../src/snapshot-logic.ts')
  assert.equal(coverageText({ shown: 87, ranked: 240, hoursBack: 24, order: 'new' }), '87 notes from 240 posts ranked in the last 24 h, new arrivals first, then best match.')
  assert.equal(coverageText({ shown: 1, ranked: 1, hoursBack: 72, order: 'best' }), '1 note from 1 post ranked in the last 3 days, best match first.')
  assert.match(coverageText({ shown: 100, ranked: 500, hoursBack: 24, order: 'best' }), /only the newest 500 posts were ranked/)
  assert.match(coverageText({ shown: 10, ranked: 20, hoursBack: 24, order: 'best', unranked: 3 }), /3 not ranked yet/)
})
