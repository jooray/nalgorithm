import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestSourceNotes, buildDigestMessages } from '../dist/index.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const post = (id, score, extra = {}) => ({
  id, type: 'original', author: A, content: `post ${id}`, createdAt: 1000, score, rawEvent: { kind: 1 }, ...extra,
})

test('digestSourceNotes: same order and cut as the digest prompt', () => {
  const posts = [post('p1', 5), post('p2', 9), post('p3', 7, { createdAt: 2000 }), post('p4', 7), post('p5', 1)]
  const notes = digestSourceNotes(posts, 3)
  assert.deepEqual(notes.map((n) => n.id), ['p2', 'p3', 'p4'])
  const prompt = buildDigestMessages({ posts, userPrompt: 'x', topN: 3 })[1].content
  const inPrompt = [...prompt.matchAll(/\d\. \[Score: \d+\/10, [^\]]+\] [^:]+: post (p\d)/g)].map((m) => m[1])
  assert.deepEqual(inPrompt, notes.map((n) => n.id))
  assert.deepEqual(digestSourceNotes(posts).map((n) => n.id), ['p2', 'p3', 'p4', 'p1', 'p5'], 'topN defaults to 15')
  assert.deepEqual(posts.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5'], 'input is not reordered')
})

test('digestSourceNotes: fields, reason and truncation', () => {
  const [n] = digestSourceNotes([post('p1', 8, { content: 'x'.repeat(2000), justification: 'about bitcoin' })], 5)
  assert.equal(n.content.length, 1500)
  assert.deepEqual({ ...n, content: '' }, { id: 'p1', pubkey: A, createdAt: 1000, content: '', score: 8, reason: 'about bitcoin', kind: 1 })
  const [bare] = digestSourceNotes([post('p2', 3)], 5)
  assert.ok(!('reason' in bare) && !('relay' in bare))
})

test('digestSourceNotes: a boost points at the original note', () => {
  const boost = post('boost1', 6, { type: 'boost', originalPost: { id: 'orig', author: B, content: 'the original' }, createdAt: 1500 })
  const [n] = digestSourceNotes([boost], 5)
  assert.equal(n.id, 'orig'); assert.equal(n.pubkey, B); assert.equal(n.content, 'the original'); assert.equal(n.createdAt, 1500)
  assert.ok(!('kind' in n))
  assert.deepEqual(digestSourceNotes([], 5), [])
})
