import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readSourceNote, readDigest, digestSourceNotes, toScoredPost, makeLocalDigest, notePubkeys,
  estimateSeconds, formatLength, firstLines, newestFirst, digestLengthLabel,
} from '../src/digest-model.ts'
import { HISTORY_CAP, withDigest } from '../src/digest-history.ts'

const hex = (c) => c.repeat(64)
const post = (id, score, extra = {}) => ({
  id: hex(id), type: 'original', author: hex('a'), content: `note ${id}`, createdAt: 1000, score,
  justification: `why ${id}`, rawEvent: { kind: 1 }, ...extra,
})
const digest = (id, createdAt, extra = {}) => ({ id: String(id), createdAt, text: 'Good morning', audioUrl: null, ...extra })

test('source notes follow the digest prompt: best score first, ties newest first, top N', () => {
  const posts = [
    post('1', 5, { createdAt: 10 }),
    post('2', 9, { createdAt: 5 }),
    post('3', 5, { createdAt: 20 }),
    post('4', 1),
  ]
  const notes = digestSourceNotes(posts, 3)
  assert.deepEqual(notes.map((n) => n.id), [hex('2'), hex('3'), hex('1')])
  assert.equal(notes[0].reason, 'why 2')
  assert.equal(notes[0].kind, 1)
})

test('a boost is recorded as the note it boosts', () => {
  const boost = {
    id: hex('b'), type: 'boost', author: hex('c'), content: '', createdAt: 50, score: 8,
    originalPost: { id: hex('d'), author: hex('e'), content: 'the original' }, rawEvent: { kind: 6 },
  }
  const [n] = digestSourceNotes([boost], 5)
  assert.equal(n.id, hex('d'))
  assert.equal(n.pubkey, hex('e'))
  assert.equal(n.content, 'the original')
  assert.equal(n.kind, 1, 'the note is a kind 1, not the kind 6 repost')
})

test('source notes are validated', () => {
  assert.equal(readSourceNote(null), null)
  assert.equal(readSourceNote({ id: 'nope' }), null)
  assert.equal(readSourceNote({ id: hex('a'), pubkey: hex('b'), createdAt: 1, content: 'x', score: NaN }), null)
  const n = readSourceNote({ id: hex('A'), pubkey: hex('b'), createdAt: 1, content: 'x', score: 12, relay: 'javascript:alert(1)', reason: '  ' })
  assert.equal(n.id, hex('a'))
  assert.equal(n.score, 10, 'clamped')
  assert.equal(n.relay, undefined)
  assert.equal(n.reason, undefined)
})

test('show notes map to renderable posts with the kind kept', () => {
  const p = toScoredPost({ id: hex('a'), pubkey: hex('b'), createdAt: 7, content: 'hi', score: 8.4, reason: 'relays', kind: 30023, relay: 'wss://r.example' })
  assert.equal(p.author, hex('b'))
  assert.equal(p.type, 'original')
  assert.equal(p.justification, 'relays')
  assert.equal(p.rawEvent.kind, 30023)
  assert.equal(p.relay, 'wss://r.example')
  assert.equal(toScoredPost({ id: hex('a'), pubkey: hex('b'), createdAt: 7, content: '', score: 1 }).rawEvent.kind, 1)
})

test('readDigest: server shape, with and without notes', () => {
  const bare = readDigest({ id: 4, createdAt: 100, text: 't', audioUrl: null })
  assert.equal(bare.id, '4')
  assert.equal(bare.notes, undefined, 'unknown, not empty')
  const full = readDigest({
    id: 5, createdAt: 100, text: 't', audioUrl: 'https://x/a.mp3',
    notes: [{ id: hex('a'), pubkey: hex('b'), createdAt: 1, content: 'c', score: 7 }, { id: 'bad' }],
  })
  assert.equal(full.notes.length, 1)
  assert.equal(readDigest({ id: 1 }), null)
  assert.equal(readDigest('x'), null)
})

test('makeLocalDigest snapshots notes and the profiles it needs', () => {
  const profiles = new Map([[hex('a'), { name: 'karel', picture: 'https://p/k.png' }], [hex('z'), { name: 'unused' }]])
  const d = makeLocalDigest({ text: '  Hello\n\nworld ', posts: [post('1', 9), post('2', 3)], topN: 1, profiles, now: 5_000_000 })
  assert.equal(d.id, 'local-5000000')
  assert.equal(d.createdAt, 5000)
  assert.equal(d.text, 'Hello\n\nworld')
  assert.equal(d.notes.length, 1)
  assert.deepEqual(Object.keys(d.profiles), [hex('a')])
  assert.deepEqual(notePubkeys(d.notes), [hex('a')])
})

test('history: newest first, deduplicated by id, capped', () => {
  let list = []
  for (let i = 0; i < HISTORY_CAP + 5; i++) list = withDigest(list, digest(i, i))
  assert.equal(list.length, HISTORY_CAP)
  assert.equal(list[0].id, String(HISTORY_CAP + 4))
  const again = withDigest(list, digest(HISTORY_CAP + 4, 999, { text: 'replaced' }))
  assert.equal(again.length, HISTORY_CAP)
  assert.equal(again[0].text, 'replaced')
})

test('lengths and lines', () => {
  assert.equal(formatLength(232), '3 min 52 s')
  assert.equal(formatLength(180), '3 min')
  assert.equal(formatLength(45), '45 s')
  assert.equal(formatLength(238, true), 'about 4 min')
  assert.equal(estimateSeconds(Array(260).fill('word').join(' ')), 100)
  assert.equal(firstLines('\n Good morning.\n\nSecond.\nThird.', 2), 'Good morning. Second.')
  assert.deepEqual(newestFirst([{ createdAt: 1, n: 'a' }, { createdAt: 3, n: 'b' }, { createdAt: 3, n: 'c' }]).map((x) => x.n), ['b', 'c', 'a'])
})

test('readDigest: the exact audio length is kept when it is a positive number, dropped otherwise', () => {
  const base = { id: 1, createdAt: 100, text: 't', audioUrl: 'https://x/a.mp3' }
  assert.equal(readDigest({ ...base, durationSeconds: 227.448 }).durationSeconds, 227.448)
  assert.equal('durationSeconds' in readDigest({ ...base, durationSeconds: null }), false, 'older digests have none')
  assert.equal('durationSeconds' in readDigest(base), false)
  for (const bad of [0, -5, '227', NaN, Infinity]) assert.equal('durationSeconds' in readDigest({ ...base, durationSeconds: bad }), false, String(bad))
})

test('digestLengthLabel: server length from the first render, the player figure after, a guess last', () => {
  const text = 'word '.repeat(300)
  // Before any playback, with the server figure: exact, no "about".
  assert.equal(digestLengthLabel({ knownSeconds: 0, played: false, serverSeconds: 227.448, text }), '3 min 47 s')
  // The player measured a streamed guess (3 min 25 s); the exact server figure is the one shown.
  assert.equal(digestLengthLabel({ knownSeconds: 205, played: false, serverSeconds: 227.448, text }), '3 min 47 s')
  // Without a server figure the player's number stays "about" until played through once.
  assert.match(digestLengthLabel({ knownSeconds: 205, played: false, text }), /^about \d+ min$/)
  assert.equal(digestLengthLabel({ knownSeconds: 227, played: true, text }), '3 min 47 s')
  // Nothing measured: a word-count guess.
  assert.match(digestLengthLabel({ knownSeconds: 0, played: false, text }), /^about \d+ min$/)
  assert.match(digestLengthLabel({ knownSeconds: 0, played: false, serverSeconds: 0, text }), /^about/)
})
