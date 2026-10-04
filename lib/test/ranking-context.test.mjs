import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankingContext, contextualScoreKey, selectDigestPosts, scorePostsCached } from '../dist/index.js'

test('explicit interest, model and learning policy isolate relevance without credentials', () => {
  const a = { userPrompt: 'Bitcoin', model: 'm', scorer: 'chat' }
  assert.equal(rankingContext(a), rankingContext({ ...a, apiKey: 'secret' }))
  for (const patch of [{ userPrompt: 'Cooking' }, { model: 'other' }, { learnFromLikes: false }]) {
    assert.notEqual(rankingContext(a), rankingContext({ ...a, ...patch }))
  }
  assert.equal(contextualScoreKey('a'.repeat(64), rankingContext(a)).length, 64)
})

test('context change actually scores again, unchanged context is free', async () => {
  const entries = {}; let calls = 0
  const store = { async getScores(keys) { return Object.fromEntries(keys.filter(k => entries[k]).map(k => [k, entries[k]])) }, async putScores(e) { Object.assign(entries,e) } }
  const ranker = { async score(posts, opts) { calls++; const out = posts.map(p => ({ ...p, score: calls })); opts.onBatchScored(out); return out } }
  const post = { id: 'a'.repeat(64), type: 'original', createdAt: 1 }
  for (const context of ['a', 'a', 'b']) await scorePostsCached({ store, ranker, scorer: 'chat' }, [post], { userPrompt: 'x', context })
  assert.equal(calls, 2)
})

test('digest selection folds boosts before cutting and excludes fallback scores', () => {
  const original = { id: 'a', type: 'original', score: 9, createdAt: 1 }
  const boost = { ...original, id: 'b', type: 'boost', originalPost: { id: 'a' } }
  const other = { ...original, id: 'c', score: 8 }
  assert.deepEqual(selectDigestPosts([original, boost, other, { ...other, id: 'd', defaultScore: true }], 2).map(p => p.id), ['a', 'c'])
})
