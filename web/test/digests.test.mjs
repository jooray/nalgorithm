import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readSourceNote, readDigest, digestSourceNotes, toScoredPost, makeLocalDigest, notePubkeys,
  estimateSeconds, formatLength, firstLines, newestFirst,
} from '../src/digest-model.ts'
import { HISTORY_CAP, loadHistory, withDigest, saveHistory, addToHistory } from '../src/digest-history.ts'

const hex = (c) => c.repeat(64)
const memory = (limit = Infinity) => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > limit) throw new Error('QuotaExceededError')
      m.set(k, String(v))
    },
    removeItem: (k) => void m.delete(k),
  }
}
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

test('history: round trips through storage and ignores junk', () => {
  const s = memory()
  addToHistory(s, readDigest, digest(1, 10))
  addToHistory(s, readDigest, digest(2, 20, { notes: [] }))
  const list = loadHistory(s, readDigest)
  assert.deepEqual(list.map((d) => d.id), ['2', '1'])
  assert.deepEqual(list[0].notes, [])
  s.setItem('nalgorithm_digest_history_v1', '[{"id":1},"x",null]')
  assert.deepEqual(loadHistory(s, readDigest), [])
  s.setItem('nalgorithm_digest_history_v1', 'nope')
  assert.deepEqual(loadHistory(s, readDigest), [])
  assert.deepEqual(loadHistory(null, readDigest), [])
})

test('history: a full store sheds the oldest digests, never the newest', () => {
  const s = memory(400)
  const list = [digest(3, 30), digest(2, 20), digest(1, 10)].map((d) => ({ ...d, text: 'x'.repeat(150) }))
  const kept = saveHistory(s, list)
  assert.ok(kept.length < 3)
  assert.equal(kept[0].id, '3')
  assert.equal(loadHistory(s, readDigest).length, kept.length)
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
