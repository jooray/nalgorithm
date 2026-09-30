import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../dist/db.js'
import { composeMessage, effectiveFormat, recordRun, runDigest } from '../dist/digest-job.js'
import { createScheduler, explain } from '../dist/scheduler.js'
import { applySchedulePatch, DEFAULT_SCHEDULE, loadSchedule, saveSchedule } from '../dist/schedule.js'
import { saveSettings, DEFAULT_SETTINGS } from '../dist/settings.js'

const NPUB = 'a'.repeat(64)
const T0 = Math.floor(Date.parse('2026-09-30T05:00:00Z') / 1000)
const silent = { info() {}, warn() {} }

let shared
after(async () => { await shared?.close() })
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['peers', 'deliveries', 'digests', 'schedules', 'scores', 'learned', 'settings', 'sessions', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

const post = (id, score) => ({ id, type: 'original', author: 'b'.repeat(64), content: `post ${id}`, createdAt: T0 - 100, score })

/** Everything the job touches, faked, with a record of what was called. */
function rig(db, over = {}) {
  const calls = { feed: 0, write: [], synth: [], upload: [], dm: [], consume: [], trials: 0 }
  const deps = {
    db, log: silent, now: () => T0,
    models: { apiBaseUrl: 'https://llm.test', apiKey: 'k', digestModel: 'dm', digestFallbackModel: 'fm', humanizerModel: 'hm', ttsModel: 'tm', ttsVoice: 'af_sky' },
    billing: {
      async entitlement() { return over.state ?? { state: 'active', until: T0 + 86400 * 5 } },
      async startTrial() { calls.trials++; return { state: 'trial', until: T0 + 3 * 86400 } },
      async consume(npub, kind, units, key) { calls.consume.push({ kind, key }); return over.consume ?? { allowed: true } },
    },
    feed: async () => { calls.feed++; if (over.feedThrows) throw new Error('relays down'); return { fetched: 3, profiles: { ['b'.repeat(64)]: { name: 'bob' } }, learnedPrompt: 'learned', posts: over.posts ?? [post('p1', 9), post('p2', 8), post('p3', 7)] } },
    writeDigest: async (o) => { calls.write.push(o); return over.text ?? 'Good morning, nostrich! Here is your digest.' },
    synthesize: async (cfg, text) => { calls.synth.push({ cfg, text }); if (over.synthThrows) throw new Error('tts down'); return over.audioBytes ?? new Uint8Array([1, 2, 3]) },
    upload: over.noUpload ? undefined : async (audio) => { calls.upload.push(audio); if (over.uploadThrows) throw new Error('blossom down'); return { url: 'https://cdn.test/abc.mp3', server: 'https://cdn.test', sha256: 'abc' } },
    dm: { async send(to, text, opts) { calls.dm.push({ to, text, opts }); if (over.dmThrows) throw new Error('relays refused'); return over.dmResult ?? [{ delivered: true, tier: 'inbox' }] } },
  }
  return { deps, calls }
}

async function withPrompt(db, extra = {}) {
  await saveSettings(db, NPUB, { ...DEFAULT_SETTINGS, userPrompt: 'bitcoin and nostr', topN: 2, ...extra }, T0)
}

test('happy path: speech-tuned digest with humanizer, audio uploaded, DM has the link first, rows recorded', async () => {
  const db = await freshDb(); await withPrompt(db)
  const { deps, calls } = rig(db)
  const out = await runDigest(deps, NPUB)
  assert.deepEqual(out, { status: 'sent', hasAudio: true })
  const w = calls.write[0]
  assert.equal(w.digest.forSpeech, true, 'speech prompt on')
  assert.equal(w.humanizer.llm.model, 'hm', 'humanizer on')
  assert.equal(w.primary.llm.model, 'dm')
  assert.equal(w.fallback.llm.model, 'fm', 'a second model is tried if the first fails')
  assert.equal(w.digest.posts.length, 2, 'top N from the user setting')
  assert.equal(w.digest.userPrompt, 'bitcoin and nostr')
  assert.equal(w.digest.learnedPrompt, 'learned')
  assert.equal(w.digest.profiles.get('b'.repeat(64)).name, 'bob')
  assert.equal(calls.synth[0].cfg.voice, 'af_sky'); assert.equal(calls.synth[0].cfg.format, 'mp3')
  const sent = calls.dm[0]
  assert.equal(sent.to, NPUB); assert.equal(sent.opts.format, 'nip17')
  const lines = sent.text.split('\n')
  assert.match(lines[0], /^Your nalgorithm digest, /); assert.equal(lines[1], 'https://cdn.test/abc.mp3')
  assert.ok(sent.text.includes('Good morning, nostrich!'))
  const d = await db.get('SELECT * FROM digests WHERE npub = ?', [NPUB])
  assert.equal(d.audio_url, 'https://cdn.test/abc.mp3'); assert.equal(d.status, 'ok')
  const del = await db.get('SELECT * FROM deliveries WHERE npub = ?', [NPUB])
  assert.equal(Number(del.delivered), 1); assert.equal(del.tier, 'inbox'); assert.equal(del.protocol, 'nip17')
})

test('the exact audio length is measured from the MP3 and stored; unreadable audio stores null', async () => {
  const { mp3 } = await import('./mp3-fixture.mjs')
  const db = await freshDb(); await withPrompt(db)
  await runDigest(rig(db, { audioBytes: mp3({ frames: 100, version: 1, bitrate: 64, rate: 44100 }) }).deps, NPUB)
  const seconds = Number((await db.get('SELECT duration_s FROM digests WHERE npub = ?', [NPUB])).duration_s)
  assert.ok(Math.abs(seconds - (100 * 1152) / 44100) < 0.001, String(seconds))
  const db2 = await freshDb(); await withPrompt(db2)
  await runDigest(rig(db2).deps, NPUB)
  assert.equal((await db2.get('SELECT duration_s FROM digests WHERE npub = ?', [NPUB])).duration_s, null)
})

test('the user\'s voice and DM format choices are honoured', async () => {
  const db = await freshDb(); await withPrompt(db)
  await saveSchedule(db, { ...DEFAULT_SCHEDULE(NPUB), voice: 'af_bella', dmFormat: 'nip04' })
  const { deps, calls } = rig(db)
  await runDigest(deps, NPUB)
  assert.equal(calls.synth[0].cfg.voice, 'af_bella'); assert.equal(calls.dm[0].opts.format, 'nip04')
})

test('DM format follows the last protocol the user wrote in when they made no explicit choice', async () => {
  const db = await freshDb()
  assert.equal(await effectiveFormat(db, NPUB), 'nip17')
  await db.run('INSERT INTO peers (npub, dm_kind, last_seen_at) VALUES (?, ?, ?)', [NPUB, 'nip04', T0])
  assert.equal(await effectiveFormat(db, NPUB), 'nip04')
  await saveSchedule(db, { ...DEFAULT_SCHEDULE(NPUB), dmFormat: 'nip17' })
  assert.equal(await effectiveFormat(db, NPUB), 'nip17', 'explicit choice wins')
})

test('no prompt: nothing is called', async () => {
  const db = await freshDb(); const { deps, calls } = rig(db)
  assert.deepEqual(await runDigest(deps, NPUB), { status: 'no_prompt' })
  assert.equal(calls.consume.length + calls.feed + calls.dm.length, 0)
})

test('entitlement gates everything before any model or feed call', async () => {
  for (const [state, expected] of [[{ state: 'expired' }, 'not_entitled'], [{ state: 'unknown' }, 'billing_unavailable']]) {
    const db = await freshDb(); await withPrompt(db)
    const { deps, calls } = rig(db, { state })
    assert.equal((await runDigest(deps, NPUB)).status, expected)
    assert.equal(calls.feed + calls.write.length + calls.synth.length + calls.dm.length, 0)
  }
})

test('a never-seen npub starts its trial on the first digest', async () => {
  const db = await freshDb(); await withPrompt(db)
  const { deps, calls } = rig(db, { state: { state: 'none' } })
  assert.equal((await runDigest(deps, NPUB)).status, 'sent')
  assert.equal(calls.trials, 1)
})

test('daily cap: scheduled runs use a per-day key, manual ones a unique key, and a cap stops the run', async () => {
  const db = await freshDb(); await withPrompt(db)
  const { deps, calls } = rig(db)
  await runDigest(deps, NPUB); await runDigest(deps, NPUB); await runDigest(deps, NPUB, { manual: true }); await runDigest(deps, NPUB, { manual: true })
  const [s1, s2, m1, m2] = calls.consume
  assert.equal(s1.key, s2.key); assert.match(s1.key, /:s:2026-09-30$/)
  assert.notEqual(m1.key, m2.key); assert.match(m1.key, /:m:/)
  assert.ok(calls.consume.every((c) => c.kind === 'digest'))
  const capped = rig(db, { consume: { allowed: false, reason: 'cap_reached' } })
  assert.equal((await runDigest(capped.deps, NPUB)).status, 'capped')
  assert.equal(capped.calls.feed, 0)
})

test('no posts: nothing is generated or sent', async () => {
  const db = await freshDb(); await withPrompt(db)
  const { deps, calls } = rig(db, { posts: [] })
  assert.deepEqual(await runDigest(deps, NPUB), { status: 'no_posts' })
  assert.equal(calls.write.length + calls.dm.length, 0)
})

test('speech failure degrades to a text-only digest, upload failure likewise', async () => {
  for (const over of [{ synthThrows: true }, { uploadThrows: true }, { noUpload: true }]) {
    const db = await freshDb(); await withPrompt(db)
    const { deps, calls } = rig(db, over)
    assert.deepEqual(await runDigest(deps, NPUB), { status: 'sent', hasAudio: false }, JSON.stringify(over))
    assert.doesNotMatch(calls.dm[0].text, /https:/); assert.ok(calls.dm[0].text.includes('Good morning'))
    assert.equal((await db.get('SELECT audio_url FROM digests WHERE npub = ?', [NPUB])).audio_url, null)
  }
})

test('a feed failure is reported without a digest or a DM', async () => {
  const db = await freshDb(); await withPrompt(db)
  const { deps, calls } = rig(db, { feedThrows: true })
  const out = await runDigest(deps, NPUB)
  assert.equal(out.status, 'failed'); assert.match(out.detail, /relays down/)
  assert.equal(calls.dm.length, 0)
})

test('a DM that is not delivered is recorded as failed, including a partial multi-part delivery', async () => {
  for (const over of [{ dmThrows: true }, { dmResult: [{ delivered: true }, { delivered: false, detail: 'rejected by all relays' }] }]) {
    const db = await freshDb(); await withPrompt(db)
    const { deps } = rig(db, over)
    assert.equal((await runDigest(deps, NPUB)).status, 'failed')
    assert.equal(Number((await db.get('SELECT delivered FROM deliveries WHERE npub = ?', [NPUB])).delivered), 0)
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM digests WHERE npub = ?', [NPUB])).n > 0, true, 'the digest is kept even if delivery failed')
  }
})

test('composeMessage puts the link on the second line and omits it without audio', () => {
  assert.match(composeMessage('Body', 'https://x/y.mp3', T0), /^Your nalgorithm digest, Wed, 30 Sep\nhttps:\/\/x\/y\.mp3\n\nBody$/)
  assert.match(composeMessage('Body', null, T0), /^Your nalgorithm digest, Wed, 30 Sep\n\nBody$/)
})

// ─── scheduling ──────────────────────────────────────────────────────────────

const enabled = (patch = {}) => applySchedulePatch(DEFAULT_SCHEDULE(NPUB), { time: '07:00', tz: 'Europe/Bratislava', enabled: true, ...patch }, T0 - 86400)

test('recordRun: success waits for tomorrow; transient failure retries soon, three times, then gives up until tomorrow', async () => {
  const db = await freshDb(); await saveSchedule(db, enabled())
  let s = await recordRun(db, NPUB, { status: 'sent' }, T0)
  assert.equal(s.lastStatus, 'sent'); assert.equal(s.attempts, 0); assert.equal(s.nextRunAt, Math.floor(Date.parse('2026-10-01T05:00:00Z') / 1000))
  s = await recordRun(db, NPUB, { status: 'failed' }, T0); assert.equal(s.attempts, 1); assert.equal(s.nextRunAt, T0 + 600)
  s = await recordRun(db, NPUB, { status: 'failed' }, T0); assert.equal(s.attempts, 2); assert.equal(s.nextRunAt, T0 + 1200)
  s = await recordRun(db, NPUB, { status: 'billing_unavailable' }, T0); assert.equal(s.attempts, 0, 'attempts reset after giving up'); assert.equal(s.nextRunAt, Math.floor(Date.parse('2026-10-01T05:00:00Z') / 1000))
  s = await recordRun(db, NPUB, { status: 'not_entitled' }, T0); assert.equal(s.attempts, 0)
})

test('recordRun leaves a paused schedule paused', async () => {
  const db = await freshDb(); await saveSchedule(db, enabled({ enabled: false }))
  assert.equal((await recordRun(db, NPUB, { status: 'sent' }, T0)).nextRunAt, null)
})

test('explain: quiet for transient scheduled failures, informative for user-actionable ones', () => {
  assert.match(explain('no_prompt', false), /prompt:/); assert.match(explain('not_entitled', false), /pay/); assert.match(explain('capped', false), /limit/)
  for (const st of ['no_posts', 'billing_unavailable', 'failed']) { assert.equal(explain(st, false), null, st); assert.ok(explain(st, true), st) }
  assert.equal(explain('sent', false), null)
})

test('scheduler tick runs due digests, advances them, and never runs one user twice at once', async () => {
  const db = await freshDb()
  await saveSchedule(db, { ...enabled(), nextRunAt: T0 - 10 })
  const ran = []
  let release
  const gate = new Promise((r) => { release = r })
  const sched = createScheduler({ db, log: silent, now: () => T0, dm: { async send() { return [{ delivered: true }] } },
    run: async (npub) => { ran.push(npub); await gate; return { status: 'sent' } } })
  const first = sched.tick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sched.isRunning(NPUB), true)
  await sched.tick() // overlaps: ticking guard and running set both prevent a second run
  assert.equal(ran.length, 1)
  release(); await first
  assert.equal(sched.isRunning(NPUB), false)
  const after = await loadSchedule(db, NPUB)
  assert.equal(after.lastStatus, 'sent'); assert.ok(after.nextRunAt > T0)
  await sched.tick(); assert.equal(ran.length, 1, 'not due again until tomorrow')
})

test('scheduler: user-actionable outcomes are notified once, not every day; a crash is contained', async () => {
  const db = await freshDb()
  const sent = []
  const dm = { async send(to, text) { sent.push(text); return [{ delivered: true }] } }
  let status = 'no_prompt'
  const sched = createScheduler({ db, log: silent, now: () => T0, dm, run: async () => ({ status }) })
  await saveSchedule(db, { ...enabled(), nextRunAt: T0 - 10 })
  await sched.tick()
  assert.equal(sent.length, 1); assert.match(sent[0], /prompt:/)
  await saveSchedule(db, { ...(await loadSchedule(db, NPUB)), nextRunAt: T0 - 10 })
  await sched.tick()
  assert.equal(sent.length, 1, 'same condition again: no second notice')
  status = 'not_entitled'
  await saveSchedule(db, { ...(await loadSchedule(db, NPUB)), nextRunAt: T0 - 10 })
  await sched.tick()
  assert.equal(sent.length, 2); assert.match(sent[1], /subscription has ended/)
  const crash = createScheduler({ db, log: silent, now: () => T0 + 999999, dm, run: async () => { throw new Error('boom') } })
  await saveSchedule(db, { ...(await loadSchedule(db, NPUB)), nextRunAt: T0 })
  await crash.tick()
  assert.equal((await loadSchedule(db, NPUB)).lastStatus, 'failed')
})
