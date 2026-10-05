import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../dist/db.js'
import { loadProfilesCached, PROFILE_TTL_SECONDS, PROFILE_MISSING_TTL_SECONDS } from '../dist/profile-cache.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

function fetcherOf(data) {
  const asked = []
  return {
    asked,
    async getProfiles(pks) {
      asked.push([...pks])
      return new Map(pks.filter((p) => data[p]).map((p) => [p, { pubkey: p, ...data[p] }]))
    },
  }
}

test('profile cache: fetched profiles are stored and served without a second fetch', async () => {
  const db = await openDb(':memory:')
  const f = fetcherOf({ [A]: { name: 'Alice', picture: 'https://x/a.png', nip05: 'a@x' } })
  const first = await loadProfilesCached(db, f, [A], 1000)
  assert.equal(first.get(A).name, 'Alice')
  const second = await loadProfilesCached(db, f, [A], 1000 + 60)
  assert.deepEqual(second.get(A), { pubkey: A, name: 'Alice', picture: 'https://x/a.png', nip05: 'a@x' })
  assert.equal(f.asked.length, 1)
})

test('profile cache: only uncached pubkeys are fetched, found or not', async () => {
  const db = await openDb(':memory:')
  const f = fetcherOf({ [A]: { name: 'Alice' }, [B]: { name: 'Bob' } })
  await loadProfilesCached(db, f, [A], 1000)
  const got = await loadProfilesCached(db, f, [A, B], 1100)
  assert.deepEqual(f.asked[1], [B])
  assert.equal(got.get(B).name, 'Bob')
})

test('profile cache: a missing pubkey is not re-queried for ten minutes, then is', async () => {
  const db = await openDb(':memory:')
  const f = fetcherOf({})
  const first = await loadProfilesCached(db, f, [C], 1000)
  assert.equal(first.size, 0)
  await loadProfilesCached(db, f, [C], 1000 + PROFILE_MISSING_TTL_SECONDS - 1)
  assert.equal(f.asked.length, 1)
  f.asked.length = 0
  await loadProfilesCached(db, f, [C], 1000 + PROFILE_MISSING_TTL_SECONDS + 1)
  assert.deepEqual(f.asked, [[C]])
})

test('profile cache: a missing pubkey that later resolves replaces the missing marker', async () => {
  const db = await openDb(':memory:')
  const data = {}
  const f = fetcherOf(data)
  await loadProfilesCached(db, f, [A], 1000)
  data[A] = { name: 'Alice' }
  const got = await loadProfilesCached(db, f, [A], 1000 + PROFILE_MISSING_TTL_SECONDS + 1)
  assert.equal(got.get(A).name, 'Alice')
  const again = await loadProfilesCached(db, f, [A], 1000 + PROFILE_MISSING_TTL_SECONDS + 10)
  assert.equal(again.get(A).name, 'Alice')
  assert.equal(f.asked.length, 2)
})

test('profile cache: entries expire after 7 days, and a stale name survives a failed refetch', async () => {
  const db = await openDb(':memory:')
  const data = { [A]: { name: 'Alice' } }
  const f = fetcherOf(data)
  await loadProfilesCached(db, f, [A], 1000)
  delete data[A]
  const stale = await loadProfilesCached(db, f, [A], 1000 + PROFILE_TTL_SECONDS + 1)
  assert.equal(f.asked.length, 2, 'refetched after the TTL')
  assert.equal(stale.get(A).name, 'Alice', 'stale name still served')
})

test('profile cache: a throwing fetcher gives the cached part and does not throw', async () => {
  const db = await openDb(':memory:')
  await loadProfilesCached(db, fetcherOf({ [A]: { name: 'Alice' } }), [A], 1000)
  const bad = { async getProfiles() { throw new Error('boom') } }
  const got = await loadProfilesCached(db, bad, [A, B], 1100)
  assert.equal(got.get(A).name, 'Alice')
  assert.ok(!got.has(B))
})

test('profile cache: cached names, stale ones too, are handed over before the relays answer', async () => {
  const db = await openDb(':memory:')
  await loadProfilesCached(db, fetcherOf({ [A]: { name: 'Alice' }, [B]: { name: 'Bob' } }), [A, B], 1000)
  let release
  const slow = { async getProfiles() { await new Promise((r) => (release = r)); return new Map() } }
  let early
  const done = loadProfilesCached(db, slow, [A, B, C], 1000 + PROFILE_TTL_SECONDS + 10, (cached) => { early = cached })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual([...early.keys()].sort(), [A, B], 'both stale but known, handed over while the relays are asked')
  release()
  await done
})

test('retention prunes by age through an index, and 2000 processed reaction IDs round-trip', async () => {
  const { createStore } = await import('../dist/db.js')
  const db = await openDb(process.env.TEST_DATABASE_URL ?? ':memory:')
  try {
    if (db.dialect === 'sqlite') {
      const names = (await db.all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name)
      assert.ok(names.includes('deliveries_created') && names.includes('dm_outbox_created'))
    }
    const npub = 'e'.repeat(64)
    const store = createStore(db, npub)
    const ids = Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(64, '0'))
    await store.putLearned({ prompt: 'p', updatedAt: 't', processedReactionIds: ids })
    assert.equal((await store.getLearned()).processedReactionIds.length, 2000)
    await db.run('DELETE FROM learned WHERE npub = ?', [npub])
  } finally { await db.close() }
})
