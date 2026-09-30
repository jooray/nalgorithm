import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peopleOf, postsToRedraw, unresolvedPeople } from '../src/lazy-profiles.ts'

const pk = (c) => c.repeat(64)

test('peopleOf: author, boosters, original and quoted authors, once each, hex only', () => {
  const post = { author: pk('a'), boostedBy: [pk('b'), pk('a'), 'nope'], originalPost: { author: pk('c') }, quotedPost: { author: pk('b') } }
  assert.deepEqual(peopleOf(post), [pk('a'), pk('b'), pk('c')])
})

test('unresolvedPeople: only people without a profile, deduplicated across posts', () => {
  const posts = [{ author: pk('a') }, { author: pk('b'), boostedBy: [pk('c')] }, { author: pk('a'), boostedBy: [pk('c')] }]
  const profiles = new Map([[pk('a'), { pubkey: pk('a'), name: 'A' }]])
  assert.deepEqual(unresolvedPeople(posts, profiles), [pk('b'), pk('c')])
  assert.deepEqual(unresolvedPeople(posts, undefined), [pk('a'), pk('b'), pk('c')])
  assert.deepEqual(unresolvedPeople([], profiles), [])
})

test('postsToRedraw: only the cards that show a newly resolved person', () => {
  const posts = [{ author: pk('a') }, { author: pk('b'), boostedBy: [pk('c')] }, { author: pk('d'), originalPost: { author: pk('c') } }]
  assert.deepEqual(postsToRedraw(posts, new Set([pk('c')])), [1, 2])
  assert.deepEqual(postsToRedraw(posts, new Set([pk('a')])), [0])
  assert.deepEqual(postsToRedraw(posts, new Set()), [])
})

test('peopleOf: people mentioned in the text, in the original and in the quote, count too', async () => {
  const { nip19 } = await import('nostr-tools')
  const npub = nip19.npubEncode(pk('d'))
  const nprofile = nip19.nprofileEncode({ pubkey: pk('e'), relays: [] })
  const post = { author: pk('a'), content: `thanks nostr:${npub}`, originalPost: { author: pk('b'), content: `cc nostr:${nprofile}` } }
  assert.deepEqual(peopleOf(post), [pk('a'), pk('b'), pk('d'), pk('e')])
  assert.deepEqual(unresolvedPeople([post], new Map([[pk('a'), {}]])), [pk('b'), pk('d'), pk('e')])
  assert.deepEqual(postsToRedraw([{ author: pk('x') }, post], new Set([pk('e')])), [1])
})
