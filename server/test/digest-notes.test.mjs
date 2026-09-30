import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as nip19 from 'nostr-tools/nip19'
import { openDb } from '../dist/db.js'
import { composeMessage, runDigest } from '../dist/digest-job.js'
import { MAX_DM_NOTES, MAX_NOTES_JSON_BYTES, notesSection, parseNotes, serializeNotes } from '../dist/digest-notes.js'
import { saveSettings, DEFAULT_SETTINGS } from '../dist/settings.js'
import { MAX_TEXT_LENGTH } from '../dist/dm/send.js'

const NPUB = 'a'.repeat(64)
const AUTHOR = 'b'.repeat(64)
const T0 = Math.floor(Date.parse('2026-09-30T05:00:00Z') / 1000)
const silent = { info() {}, warn() {} }
const hex = (n) => n.toString(16).padStart(64, '0')

let shared
after(async () => { await shared?.close() })
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['peers', 'deliveries', 'digests', 'schedules', 'scores', 'learned', 'settings', 'sessions', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

const note = (i, extra = {}) => ({ id: hex(i), pubkey: AUTHOR, createdAt: T0 - i, content: `note ${i}`, score: 9 - i, ...extra })

function rig(db, posts, text) {
  const calls = { synth: [], dm: [] }
  const deps = {
    db, log: silent, now: () => T0,
    models: { apiBaseUrl: 'https://llm.test', apiKey: 'k', digestModel: 'dm', humanizerModel: 'hm', ttsModel: 'tm', ttsVoice: 'af_sky' },
    billing: {
      async entitlement() { return { state: 'active', until: T0 + 86400 } },
      async startTrial() { return { state: 'trial', until: T0 + 86400 } },
      async consume() { return { allowed: true } },
    },
    feed: async () => ({ fetched: posts.length, profiles: {}, learnedPrompt: '', posts }),
    writeDigest: async () => text,
    synthesize: async (cfg, t) => { calls.synth.push(t); return new Uint8Array([1]) },
    upload: async () => ({ url: 'https://cdn.test/a.mp3', server: 'https://cdn.test', sha256: 'abc' }),
    dm: { async send(to, t) { calls.dm.push(t); return [{ delivered: true, tier: 'inbox' }] } },
  }
  return { deps, calls }
}

const post = (i, score, extra = {}) => ({ id: hex(i), type: 'original', author: AUTHOR, content: `post ${i}`, createdAt: T0 - 100 - i, score, rawEvent: { kind: 1 }, ...extra })

test('a digest stores its ordered notes; the DM lists them after the spoken text; TTS never sees them', async () => {
  const db = await freshDb()
  await saveSettings(db, NPUB, { ...DEFAULT_SETTINGS, userPrompt: 'bitcoin', topN: 2 }, T0)
  const { deps, calls } = rig(db, [post(1, 5), post(2, 9, { justification: 'about bitcoin' }), post(3, 7)], 'Good morning, nostrich! Spoken text.')
  assert.equal((await runDigest(deps, NPUB)).status, 'sent')

  const row = await db.get('SELECT notes FROM digests WHERE npub = ?', [NPUB])
  const stored = parseNotes(row.notes)
  assert.deepEqual(stored.map((n) => n.id), [hex(2), hex(1)], 'same posts and order the digest was written from (the feed is cut at topN, then sorted)')
  assert.equal(stored[0].reason, 'about bitcoin'); assert.equal(stored[0].kind, 1)

  assert.deepEqual(calls.synth, ['Good morning, nostrich! Spoken text.'], 'speech input is the spoken text only')
  const dm = calls.dm[0]
  assert.ok(dm.includes('Spoken text.\n\nNotes:\nnostr:nevent1'))
  const links = dm.split('\nNotes:\n')[1].split('\n')
  assert.equal(links.length, 2)
  const decoded = nip19.decode(links[0].replace('nostr:', ''))
  assert.equal(decoded.type, 'nevent'); assert.equal(decoded.data.id, hex(2)); assert.equal(decoded.data.author, AUTHOR)
})

test('notes section: relay hint, max 10, nothing when empty', () => {
  const [line] = notesSection([note(1, { relay: 'wss://relay.test' })]).split('\n').slice(3)
  assert.deepEqual(nip19.decode(line.replace('nostr:', '')).data.relays, ['wss://relay.test'])
  const many = Array.from({ length: 15 }, (_, i) => note(i + 1))
  assert.equal(notesSection(many).split('\n').length, 3 + MAX_DM_NOTES)
  assert.equal(notesSection([]), '')
  assert.equal(composeMessage('spoken', null, T0), composeMessage('spoken', null, T0, []), 'no notes, no section')
})

test('DM over the length limit: the notes list is cut, never the spoken text', () => {
  const notes = Array.from({ length: 10 }, (_, i) => note(i + 1))
  const header = composeMessage('', null, T0).length
  const spoken = 'x'.repeat(MAX_TEXT_LENGTH - header - 400)
  const msg = composeMessage(spoken, null, T0, notes)
  assert.ok(msg.length <= MAX_TEXT_LENGTH)
  assert.ok(msg.includes(spoken))
  const kept = msg.split('\nNotes:\n')[1].split('\n').length
  assert.ok(kept >= 1 && kept < 10, `kept ${kept}`)
  const tight = composeMessage('x'.repeat(MAX_TEXT_LENGTH - header), null, T0, notes)
  assert.ok(!tight.includes('Notes:') && tight.includes('x'.repeat(MAX_TEXT_LENGTH - header)))
})

test('stored notes JSON is bounded, and malformed or missing JSON reads as empty', () => {
  const big = Array.from({ length: 15 }, (_, i) => note(i + 1, { content: 'é'.repeat(1500), reason: 'r'.repeat(300) }))
  const json = serializeNotes(big)
  assert.ok(Buffer.byteLength(json) <= MAX_NOTES_JSON_BYTES)
  assert.equal(parseNotes(json).length, 15, 'contents are trimmed before notes are dropped')
  assert.equal(serializeNotes([]), null)
  assert.equal(serializeNotes([{ ...note(1), id: 'not-hex' }]), null)
  for (const bad of [null, undefined, '', 'nope', '{"a":1}', '[1,2]']) assert.deepEqual(parseNotes(bad), [])
})

test('migration: a digests table from before the notes column gains it, keeping its rows', async () => {
  const { openDatabase } = await import('../dist/database.js')
  if (process.env.TEST_DATABASE_URL) return
  const { openDb: open } = await import('../dist/db.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'nalg-')), 'old.db')
  const old = await openDatabase(file)
  await old.exec('CREATE TABLE digests (id INTEGER PRIMARY KEY, npub TEXT NOT NULL, created_at BIGINT NOT NULL, body TEXT NOT NULL, audio_url TEXT NULL, status TEXT NOT NULL)')
  await old.run('INSERT INTO digests (npub, created_at, body, status) VALUES (?, ?, ?, ?)', [NPUB, T0, 'old digest', 'ok'])
  await old.close()
  const db = await open(file)
  assert.equal((await db.get('SELECT notes, body FROM digests')).notes, null)
  await db.close()
  const again = await open(file) // running it twice is fine
  assert.equal((await again.get('SELECT body FROM digests')).body, 'old digest')
  await again.close()
})

test('a digest longer than one DM is cut at a paragraph and points to the app; it is not a failure', async () => {
  const { MAX_TEXT_LENGTH } = await import('../dist/dm/send.js')
  const para = 'Sentence one is here. Sentence two follows it closely.'
  const text = Array.from({ length: 400 }, () => para).join('\n\n')
  assert.ok(text.length > MAX_TEXT_LENGTH)
  const msg = composeMessage(text, 'https://a/x.mp3', T0, [], 'https://app.test/app/')
  assert.ok(msg.length <= MAX_TEXT_LENGTH, `message is ${msg.length}`)
  assert.match(msg, /^Your nalgorithm digest, .*\nhttps:\/\/a\/x\.mp3\n\nSentence one/)
  assert.match(msg, /…\nThe rest of the text, and every note, is in the app: https:\/\/app\.test\/app\/$/)
  assert.ok(msg.includes(para + '\n\n…') || /\.\n\n…/.test(msg), 'cut on a sentence end, not mid-word')
  assert.equal(composeMessage('short', null, T0), composeMessage('short', null, T0, [], 'https://app.test/'), 'short digests are untouched')
})
