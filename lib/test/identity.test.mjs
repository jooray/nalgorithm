import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nip19 from 'nostr-tools/nip19'
import {
  collectPostPubkeys,
  extractReferencedPubkeys,
  parseProfileEvents,
  formatPostForDigest,
  buildDigestMessages,
} from '../dist/index.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)

test('extractReferencedPubkeys reads npub and nprofile, ignores junk', () => {
  const text = `hi nostr:${nip19.npubEncode(A)} and nostr:${nip19.nprofileEncode({ pubkey: B, relays: ['wss://r.example'] })} nostr:npub1notvalid`
  assert.deepEqual([...extractReferencedPubkeys(text)].sort(), [A, B])
})

test('collectPostPubkeys covers booster, original, quoted and mentioned authors', () => {
  const posts = [
    { author: A, content: '', originalPost: { author: B, content: `cc nostr:${nip19.npubEncode(D)}` } },
    { author: C, content: 'quote', quotedPost: { author: A, content: '' } },
  ]
  assert.deepEqual(collectPostPubkeys(posts), [A, B, C, D])
})

test('collectPostPubkeys caps mentions before authors', () => {
  const posts = [{ author: A, content: `nostr:${nip19.npubEncode(D)}`, originalPost: { author: B, content: '' } }]
  assert.deepEqual(collectPostPubkeys(posts, 2), [A, B])
})

test('parseProfileEvents keeps the newest event, prefers display_name, skips bad JSON', () => {
  const out = parseProfileEvents([
    { pubkey: A, created_at: 1, content: JSON.stringify({ name: 'old' }) },
    { pubkey: A, created_at: 2, content: JSON.stringify({ name: 'nick', display_name: 'Alice' }) },
    { pubkey: B, created_at: 1, content: 'not json' },
    { pubkey: C, created_at: 1, content: JSON.stringify({ display_name: '  ', name: 'carol' }) },
  ])
  assert.equal(out.get(A).name, 'Alice')
  assert.equal(out.has(B), false)
  assert.equal(out.get(C).name, 'carol')
})

test('digest never contains hex for unresolved authors', () => {
  const post = {
    id: 'e'.repeat(64), type: 'boost', author: A, content: '', createdAt: 1, score: 8,
    originalPost: { id: 'f'.repeat(64), author: B, content: 'hello' },
  }
  const line = formatPostForDigest(post, 0)
  assert.match(line, /Boosted by someone you follow\] Originally by someone you follow: hello/)
  const messages = buildDigestMessages({ posts: [post], userPrompt: 'x' })
  assert.doesNotMatch(messages[1].content, /[0-9a-f]{8}/)
})
