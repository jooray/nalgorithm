import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nip19 from 'nostr-tools/nip19'
import {
  aggregateBoosts, authorLabel, avatarInitial, npubOf, nprofileOf, profileName,
  summarizeBoosters, tokenizeContent, pubkeyOfProfileRef,
} from '../src/identity.ts'

const pk = (c) => c.repeat(64)
const note = (id, author, extra = {}) => ({ id, type: 'original', author, content: `note ${id}`, createdAt: 100, score: 5, ...extra })
const boost = (id, booster, orig, extra = {}) => ({
  id, type: 'boost', author: booster, content: '', createdAt: 200, score: 5,
  originalPost: { id: orig, author: pk('9'), content: `orig ${orig}` }, ...extra,
})

test('a boost folds into the original when both are in the list', () => {
  const out = aggregateBoosts([boost('b1', pk('a'), 'n1'), note('n1', pk('9'))])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'n1')
  assert.equal(out[0].type, 'original')
  assert.equal(out[0].author, pk('9'))
  assert.equal(out[0].createdAt, 100, 'the note keeps its own time')
  assert.deepEqual(out[0].boostedBy, [pk('a')])
})

test('original first, then boosts: same result', () => {
  const out = aggregateBoosts([note('n1', pk('9')), boost('b1', pk('a'), 'n1'), boost('b2', pk('b'), 'n1')])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].boostedBy, [pk('a'), pk('b')])
})

test('several boosts without the original become one card built from the embedded original', () => {
  const out = aggregateBoosts([
    boost('b1', pk('a'), 'n1', { createdAt: 300 }),
    boost('b2', pk('b'), 'n1', { createdAt: 500 }),
    boost('b3', pk('c'), 'n1', { createdAt: 400 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].author, pk('9'))
  assert.equal(out[0].content, 'orig n1')
  assert.equal(out[0].id, 'n1')
  assert.equal(out[0].type, 'original')
  assert.equal(out[0].createdAt, 500, 'latest boost stands in for the missing note time')
  assert.deepEqual(out[0].boostedBy, [pk('a'), pk('b'), pk('c')])
})

test('highest score and its justification win; a raised score re-sorts', () => {
  const out = aggregateBoosts([
    note('x', pk('1'), { score: 7 }),
    note('n1', pk('9'), { score: 3, justification: 'low' }),
    boost('b1', pk('a'), 'n1', { score: 9, justification: 'high' }),
  ])
  assert.deepEqual(out.map((p) => p.id), ['n1', 'x'])
  assert.equal(out[0].score, 9)
  assert.equal(out[0].justification, 'high')
})

test('order is untouched when no score is raised', () => {
  const out = aggregateBoosts([note('a', pk('1'), { score: 9 }), note('b', pk('2'), { score: 5 }), boost('b1', pk('c'), 'b', { score: 2 })])
  assert.deepEqual(out.map((p) => p.id), ['a', 'b'])
})

test('quote posts are left alone; a boost of a quote folds into the quote', () => {
  const quote = { id: 'q1', type: 'quote', author: pk('1'), content: 'my take', createdAt: 1, score: 5, quotedPost: { id: 'n1', author: pk('9'), content: 'x' } }
  const out = aggregateBoosts([quote, note('n1', pk('9'))])
  assert.equal(out.length, 2)
  assert.equal(out[0].boostedBy, undefined)
  const folded = aggregateBoosts([quote, boost('b1', pk('a'), 'q1')])
  assert.equal(folded.length, 1)
  assert.equal(folded[0].type, 'quote')
  assert.deepEqual(folded[0].boostedBy, [pk('a')])
})

test('duplicate boosters and duplicate notes collapse', () => {
  const out = aggregateBoosts([note('n1', pk('9')), note('n1', pk('9')), boost('b1', pk('a'), 'n1'), boost('b2', pk('a'), 'n1')])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].boostedBy, [pk('a')])
})

test('a boost whose original is unresolved stays a plain entry and inputs are not mutated', () => {
  const b = { id: 'b1', type: 'boost', author: pk('a'), content: '', createdAt: 1, score: 1 }
  const n = note('n1', pk('9'))
  const input = [b, n, boost('b2', pk('c'), 'n1')]
  const snapshot = JSON.stringify(input)
  const out = aggregateBoosts(input)
  assert.equal(out.length, 2)
  assert.equal(out[0].boostedBy, undefined)
  assert.equal(JSON.stringify(input), snapshot)
})

test('summarizeBoosters shows four in full, else three and the rest', () => {
  const ks = ['1', '2', '3', '4', '5', '6'].map(pk)
  assert.deepEqual(summarizeBoosters(ks.slice(0, 4)), { shown: ks.slice(0, 4), rest: [] })
  assert.deepEqual(summarizeBoosters(ks), { shown: ks.slice(0, 3), rest: ks.slice(3) })
})

test('author label: name when known, full npub otherwise, never hex', () => {
  const key = pk('a')
  assert.deepEqual(authorLabel(key, { name: 'Alice' }), { text: 'Alice', isNpub: false })
  const unknown = authorLabel(key)
  assert.equal(unknown.isNpub, true)
  assert.equal(unknown.text, nip19.npubEncode(key))
  assert.ok(unknown.text.length > 60, 'complete npub, not truncated')
  assert.doesNotMatch(unknown.text, /[0-9a-f]{64}/)
  assert.equal(authorLabel(key, { name: pk('b') }).isNpub, true, 'a name that is a bare key does not count')
  assert.equal(authorLabel('not a key').text, '', 'invalid key yields nothing, not hex')
})

test('avatar initial is derived from the name, never from a key', () => {
  assert.equal(avatarInitial({ name: 'alice' }), 'A')
  assert.equal(avatarInitial({ name: '  ⚡ bob' }), 'B')
  assert.equal(avatarInitial(), '?')
  assert.equal(avatarInitial({ name: pk('f') }), '?')
  assert.equal(profileName({ name: ' ' }), undefined)
})

test('nprofile round trip keeps the pubkey and at most three relay hints', () => {
  const relays = ['wss://a.example', 'wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example', 'javascript:x']
  const decoded = nip19.decode(nprofileOf(pk('a'), relays))
  assert.equal(decoded.type, 'nprofile')
  assert.equal(decoded.data.pubkey, pk('a'))
  assert.deepEqual(decoded.data.relays, ['wss://a.example', 'wss://b.example', 'wss://c.example'])
  assert.equal(nip19.decode(nprofileOf(pk('a'))).data.relays?.length ?? 0, 0, 'no relays, no invented hints')
  assert.equal(nip19.decode(npubOf(pk('a'))).data, pk('a'))
})

test('tokenizeContent finds mentions, refs and urls; text stays text', () => {
  const npub = nip19.npubEncode(pk('a'))
  const nprofile = nip19.nprofileEncode({ pubkey: pk('b') })
  const nevent = nip19.neventEncode({ id: pk('c') })
  const tokens = tokenizeContent(`<b>hi</b> nostr:${npub} and nostr:${nprofile}, see nostr:${nevent} (https://example.com/x) end`)
  const kinds = tokens.map((t) => t.kind)
  assert.deepEqual(kinds, ['text', 'profile', 'text', 'profile', 'text', 'ref', 'text', 'url', 'text'])
  assert.equal(tokens[0].text, '<b>hi</b> ', 'markup is text, escaping is the renderer\'s textContent')
  assert.equal(tokens[1].pubkey, pk('a'))
  assert.equal(tokens[3].pubkey, pk('b'))
  assert.equal(tokens[7].url, 'https://example.com/x')
  assert.equal(pubkeyOfProfileRef('npub1broken'), null)
})
