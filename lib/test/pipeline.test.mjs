import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scorePostsCached,
  writeDigest,
  refreshLearnedPrompt,
  scoreCacheKey,
  buildDigestMessages,
  HUMANIZER_APPENDIX,
  silentLogger,
} from '../dist/index.js'

const post = (id, extra = {}) => ({
  id,
  type: 'original',
  author: 'a'.repeat(64),
  content: `post ${id}`,
  createdAt: 1000,
  rawEvent: {},
  ...extra,
})

function memoryStore(scores = {}, learned = null) {
  const store = {
    scores: { ...scores },
    learned,
    flushed: 0,
    async getLearned() { return this.learned },
    async putLearned(s) { this.learned = s },
    async getScores(keys) {
      const out = {}
      for (const k of keys) if (this.scores[k]) out[k] = this.scores[k]
      return out
    },
    async putScores(e) { Object.assign(this.scores, e) },
    async flush() { this.flushed++ },
  }
  return store
}

function fakeRanker(scoreFor, calls = []) {
  return {
    async score(posts, opts) {
      calls.push(posts.map((p) => p.id))
      const scored = posts.map((p) => ({ ...p, ...scoreFor(p) }))
      opts.onBatchScored?.(scored)
      opts.onProgress?.(scored.length, posts.length)
      return scored
    },
  }
}

// Stub global fetch with a scripted chat-completions endpoint.
function stubChat(handler) {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push(body)
    const result = handler(body, seen.length)
    if (result instanceof Error) throw result
    return new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200 })
  }
  return { seen, restore: () => { globalThis.fetch = original } }
}

test('scorePostsCached scores only uncached posts and keeps input order', async () => {
  const store = memoryStore({ b: { score: 8, createdAt: 1000 } })
  const calls = []
  const ranker = fakeRanker(() => ({ score: 3 }), calls)
  const out = await scorePostsCached(
    { ranker, store, scorer: 'chat', log: silentLogger },
    [post('a'), post('b'), post('c')],
    { userPrompt: 'x' },
  )
  assert.deepEqual(calls, [['a', 'c']])
  assert.deepEqual(out.map((p) => [p.id, p.score]), [['a', 3], ['b', 8], ['c', 3]])
  assert.equal(store.scores.a.score, 3)
  assert.equal(store.flushed, 1)
})

test('scorePostsCached ignores scores from the other scorer', async () => {
  const store = memoryStore({ a: { score: 9, createdAt: 1000, scorer: 'decision' } })
  const calls = []
  await scorePostsCached(
    { ranker: fakeRanker(() => ({ score: 2 }), calls), store, scorer: 'chat', log: silentLogger },
    [post('a')],
    { userPrompt: 'x' },
  )
  assert.deepEqual(calls, [['a']])
})

test('scorePostsCached tags decision scores and does not cache defaulted posts', async () => {
  const store = memoryStore()
  const ranker = fakeRanker((p) => (p.id === 'bad' ? { score: 5, defaultScore: true } : { score: 6 }))
  const out = await scorePostsCached(
    { ranker, store, scorer: 'decision', log: silentLogger },
    [post('good'), post('bad')],
    { userPrompt: 'x' },
  )
  assert.equal(store.scores.good.scorer, 'decision')
  assert.equal('bad' in store.scores, false)
  assert.equal(out.find((p) => p.id === 'bad').defaultScore, true)
})

test('scorePostsCached reuses a boost target score', async () => {
  const boost = post('boost1', { type: 'boost', originalPost: { id: 'orig', author: 'x', content: 'y', createdAt: 1 } })
  assert.equal(scoreCacheKey(boost), 'orig')
  const store = memoryStore({ orig: { score: 7, justification: 'j', createdAt: 1000 } })
  const calls = []
  const out = await scorePostsCached(
    { ranker: fakeRanker(() => ({ score: 1 }), calls), store, scorer: 'chat', log: silentLogger },
    [boost],
    { userPrompt: 'x' },
  )
  assert.deepEqual(calls, [])
  assert.equal(out[0].score, 7)
  assert.equal(out[0].justification, 'j')
})

test('digest system prompt carries the humanizer rules exactly once', () => {
  const msgs = buildDigestMessages({ posts: [{ ...post('a'), score: 5 }], userPrompt: 'x' })
  const sys = msgs[0].content
  assert.equal(sys.split(HUMANIZER_APPENDIX).length - 1, 1)
})

test('writeDigest falls back to the second model when the first fails', { timeout: 30000 }, async () => {
  const chat = stubChat((body) => (body.model === 'primary' ? new Error('boom') : 'fallback digest'))
  try {
    const out = await writeDigest({
      primary: { llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'primary' } },
      fallback: { llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'fallback' } },
      digest: { posts: [{ ...post('a'), score: 5 }], userPrompt: 'x' },
    })
    assert.equal(out, 'fallback digest')
    assert.equal(chat.seen.at(-1).model, 'fallback')
  } finally {
    chat.restore()
  }
})

test('writeDigest rethrows when there is no fallback', { timeout: 30000 }, async () => {
  const chat = stubChat(() => new Error('boom'))
  try {
    await assert.rejects(
      writeDigest({
        primary: { llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'primary' } },
        digest: { posts: [{ ...post('a'), score: 5 }], userPrompt: 'x' },
      }),
    )
  } finally {
    chat.restore()
  }
})

test('refreshLearnedPrompt keeps the stored prompt when there are no new likes', async () => {
  const store = memoryStore({}, { prompt: 'old', updatedAt: 't', lastLikeTimestamp: 100 })
  let sinceSeen
  const fetcher = { async getLikes(_pk, o) { sinceSeen = o.since; return [] } }
  const out = await refreshLearnedPrompt({ fetcher, store, now: () => 1_000_000, llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm' }, pubkeyHex: 'p' })
  assert.equal(out, 'old')
  assert.equal(sinceSeen, 0, 'overlap catches delayed reactions; processed IDs prevent duplicate learning')
})

test('refreshLearnedPrompt evolves the prompt and advances the high-water mark', async () => {
  const chat = stubChat(() => 'new summary')
  try {
    const store = memoryStore({}, { prompt: 'old', updatedAt: 't', lastLikeTimestamp: 100 })
    const fetcher = { async getLikes() { return [{ content: 'liked' }] } }
    const out = await refreshLearnedPrompt({
      fetcher, store, pubkeyHex: 'p', pauseMs: 0, now: () => 5_000_000,
      llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm' },
    })
    assert.equal(out, 'new summary')
    assert.equal(store.learned.prompt, 'new summary')
    assert.equal(store.learned.lastLikeTimestamp, 5000)
  } finally {
    chat.restore()
  }
})

test('refreshLearnedPrompt survives an LLM failure and keeps the old prompt', { timeout: 30000 }, async () => {
  const chat = stubChat(() => new Error('down'))
  try {
    const store = memoryStore({}, { prompt: 'old', updatedAt: 't', lastLikeTimestamp: 100 })
    const fetcher = { async getLikes() { return [{ content: 'liked' }] } }
    const out = await refreshLearnedPrompt({
      fetcher, store, pubkeyHex: 'p', pauseMs: 0,
      llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm' },
    })
    assert.equal(out, 'old')
    assert.equal(store.learned.lastLikeTimestamp, 100)
  } finally {
    chat.restore()
  }
})

test('learning deduplicates reaction IDs and advances to reaction time, not completion time', async () => {
  const chat = stubChat(() => 'new taste')
  try {
    const store = memoryStore({}, { prompt: 'old', updatedAt: 't', lastLikeTimestamp: 100, processedReactionIds: ['old'] })
    const fetcher = { async getLikes() { return [{ id: 'a', content: 'old', reactionId: 'old', reactedAt: 110 }, { id: 'b', content: 'new', reactionId: 'new', reactedAt: 120 }] } }
    await refreshLearnedPrompt({ fetcher, store, pubkeyHex: 'p', pauseMs: 0, now: () => 5000000, llm: { apiBaseUrl: 'http://x', apiKey: '', model: 'm' } })
    assert.equal(store.learned.lastLikeTimestamp, 120)
    assert.ok(store.learned.processedReactionIds.includes('new'))
    await refreshLearnedPrompt({ fetcher, store, pubkeyHex: 'p', pauseMs: 0, llm: { apiBaseUrl: 'http://x', apiKey: '', model: 'm' } })
    assert.equal(chat.seen.length, 1)
  } finally { chat.restore() }
})

test('learning: the first run reads only the newest page and sets the watermark there, no backfill', async () => {
  const chat = stubChat(() => 'first taste')
  try {
    const store = memoryStore()
    const asked = []
    const page = Object.assign(Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, content: `like ${i}`, reactionId: `r${i}`, reactedAt: 4000 + i })), { reactionCount: 200, nextUntil: 3999 })
    const fetcher = { async getLikes(_pk, o) { asked.push(o); return page } }
    await refreshLearnedPrompt({ fetcher, store, pubkeyHex: 'p', pauseMs: 0, batchSize: 200, now: () => 5_000_000, llm: { apiBaseUrl: 'http://x', apiKey: '', model: 'm' } })
    assert.deepEqual(asked[0], { limit: 200 }, 'no since, no until')
    assert.equal(store.learned.backfillUntil, undefined, 'a full first page does not start a walk through history')
    assert.equal(store.learned.lastLikeTimestamp, 4199)
  } finally { chat.restore() }
})

test('learning: catch-up after a long absence reaches back at most the age cap', async () => {
  const { LEARN_MAX_AGE_SECONDS } = await import('../dist/index.js')
  const store = memoryStore({}, { prompt: 'old', updatedAt: 't', lastLikeTimestamp: 100, backfillUntil: 200 })
  let seen
  const fetcher = { async getLikes(_pk, o) { seen = o; return [] } }
  const nowSec = 400 * 86_400
  await refreshLearnedPrompt({ fetcher, store, pubkeyHex: 'p', now: () => nowSec * 1000, llm: { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm' } })
  assert.equal(seen.since, nowSec - LEARN_MAX_AGE_SECONDS)
  assert.equal(seen.until, undefined, 'a backfill boundary older than the cap is dropped')
})

test('scorePostsCached waits for a turn only when something needs scoring, and always gives it back', async () => {
  const events = []
  const beforeScoring = async (n) => { events.push(`enter ${n}`); return () => events.push('leave') }
  await scorePostsCached({ ranker: fakeRanker(() => ({ score: 3 })), store: memoryStore({ a: { score: 8, createdAt: 1000 } }), scorer: 'chat', log: silentLogger }, [post('a')], { userPrompt: 'x', beforeScoring })
  assert.deepEqual(events, [], 'all cached: no line')
  await scorePostsCached({ ranker: fakeRanker(() => ({ score: 3 })), store: memoryStore(), scorer: 'chat', log: silentLogger }, [post('a'), post('b')], { userPrompt: 'x', beforeScoring })
  assert.deepEqual(events, ['enter 2', 'leave'])
  const failing = { async score() { throw new Error('provider down') } }
  await assert.rejects(scorePostsCached({ ranker: failing, store: memoryStore(), scorer: 'chat', log: silentLogger }, [post('c')], { userPrompt: 'x', beforeScoring }))
  assert.deepEqual(events.slice(2), ['enter 1', 'leave'], 'a failed run gives its turn back')
})
