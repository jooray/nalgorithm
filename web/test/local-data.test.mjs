import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

const compiled = await build({ entryPoints: ['src/local-data.ts'], absWorkingDir: new URL('..', import.meta.url).pathname, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const memory = new Map()
const localStorage = {
  get length() { return memory.size }, key: (i) => [...memory.keys()][i] ?? null,
  getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k),
}
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, indexedDB, IDBKeyRange, localStorage, TextEncoder, TextDecoder, crypto: globalThis.crypto, Uint8Array, Map, Set, URL, console, setTimeout })
const data = module.exports

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const read = (v) => (v && typeof v.id === 'string' ? v : null)
const digest = (id, createdAt) => ({ id, createdAt, text: 'x' })
const snap = (id) => ({ v: 1, createdAt: 1, posts: [{ id }], profiles: {} })

test('a legacy BYOK history moves to the identity it was written for, and nobody else sees it', async () => {
  memory.set('nalgorithm_digest_history_v1', JSON.stringify([digest('old', 1)]))
  data.setLegacyOwner((mode) => (mode === 'byok' ? A : null))
  assert.equal((await data.loadDigestHistory('byok', B, read)).length, 0)
  assert.ok(memory.has('nalgorithm_digest_history_v1'), 'not dropped for the wrong identity')
  assert.deepEqual([...(await data.loadDigestHistory('byok', A, read)).map((d) => d.id)], ['old'])
  assert.equal(memory.has('nalgorithm_digest_history_v1'), false, 'dropped once safely moved')
  assert.deepEqual([...(await data.loadDigestHistory('byok', A, read)).map((d) => d.id)], ['old'])
  assert.equal((await data.loadDigestHistory('hosted', A, read)).length, 0, 'modes are separate')
})

test('digests finishing together both survive', async () => {
  await Promise.all([data.addDigestToHistory('byok', B, read, digest('one', 2)), data.addDigestToHistory('byok', B, read, digest('two', 3))])
  assert.deepEqual([...(await data.loadDigestHistory('byok', B, read)).map((d) => d.id)], ['two', 'one'])
})

test('feed snapshots migrate, stay per identity, and only the newest few identities are kept', async () => {
  memory.set('nalgorithm_hosted_feed_' + A, JSON.stringify(snap('legacy')))
  assert.equal((await data.loadFeedSnapshot('hosted', A)).posts[0].id, 'legacy')
  assert.equal(memory.has('nalgorithm_hosted_feed_' + A), false)
  assert.equal(await data.loadFeedSnapshot('hosted', B), null)
  for (const c of ['c', 'd', 'e']) await data.saveFeedSnapshot('hosted', c.repeat(64), snap(c))
  assert.equal(await data.loadFeedSnapshot('hosted', A), null, 'the oldest identity went')
  assert.equal((await data.loadFeedSnapshot('hosted', 'e'.repeat(64))).posts[0].id, 'e')
})

test('clearing one identity leaves the others', async () => {
  await data.saveDigestHistory('hosted', A, [digest('a', 1)])
  await data.saveDigestHistory('hosted', B, [digest('b', 1)])
  await data.clearIdentityData('hosted', A)
  assert.equal((await data.loadDigestHistory('hosted', A, read)).length, 0)
  assert.equal((await data.loadDigestHistory('hosted', B, read)).length, 1)
  assert.equal(await data.saveDigestHistory('hosted', 'not-an-identity', []), false)
})
