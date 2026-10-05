import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionWithRetry, createRanker } from '../dist/index.js'
test('bad credentials fail once and a local model sends no Authorization', async () => {
  const original = globalThis.fetch; let calls = 0
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.headers.Authorization, undefined); return new Response('{}', { status: 401 }) }
  try { await assert.rejects(chatCompletionWithRetry({ apiBaseUrl: 'http://localhost/v1', model: 'x', apiKey: '' }, [], false, 3, 0), /401/); assert.equal(calls, 1) } finally { globalThis.fetch = original }
})
test('ranker rejects invalid chunk configuration instead of freezing', () => {
  assert.throws(() => createRanker({ batchSize: -1 }), /batch size/)
  assert.throws(() => createRanker({ concurrency: 100 }), /concurrency/)
})
test('ranker: a 400 costs one batch its scores, a 401 stops the run', async () => {
  const original = globalThis.fetch
  const posts = [{ id: 'a', type: 'original', author: 'b'.repeat(64), content: 'x', createdAt: 1, rawEvent: {} }]
  try {
    globalThis.fetch = async () => new Response('{}', { status: 400 })
    const out = await createRanker({ apiBaseUrl: 'http://errors.test/v1', apiKey: 'k', model: 'm', scorer: 'decision' }).score(posts, { userPrompt: 'x' })
    assert.equal(out[0].defaultScore, true)
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await assert.rejects(createRanker({ apiBaseUrl: 'http://errors.test/v1', apiKey: 'k', model: 'm', scorer: 'decision' }).score(posts, { userPrompt: 'x' }), /401/)
  } finally { globalThis.fetch = original }
})
