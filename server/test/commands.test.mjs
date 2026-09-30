import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createStore } from '../dist/db.js'
import { parseCommand, handleCommand, deleteUserData, HELP } from '../dist/commands.js'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../dist/settings.js'
import { loadSchedule, saveSchedule, DEFAULT_SCHEDULE } from '../dist/schedule.js'

const NPUB = 'a'.repeat(64)
const T0 = Math.floor(Date.parse('2026-09-30T03:00:00Z') / 1000)

let shared
after(async () => { await shared?.close() })
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['peers', 'deliveries', 'digests', 'schedules', 'scores', 'learned', 'settings', 'sessions', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

function deps(db, over = {}) {
  const calls = { charges: [], digests: [] }
  return {
    calls,
    d: {
      db,
      now: () => T0,
      webUrl: 'https://example.test/app/',
      billing: {
        async entitlement() { return over.state ?? { state: 'trial', until: T0 + 2 * 86400 } },
        async createCharge(npub, plan, sats) { calls.charges.push({ npub, plan, sats }); if (over.chargeFails) throw new Error('down'); return { invoice_id: 'i1', checkout_url: 'https://pay.example/i/i1' } },
      },
      async runDigestNow(npub) { calls.digests.push(npub); return 'Working on it.' },
    },
  }
}

test('parser: commands, aliases and argument forms', () => {
  assert.deepEqual(parseCommand('help'), { name: 'help' })
  assert.deepEqual(parseCommand('  GM '), { name: 'help' })
  assert.deepEqual(parseCommand('prompt: bitcoin, nostr and privacy'), { name: 'prompt', text: 'bitcoin, nostr and privacy' })
  assert.deepEqual(parseCommand('/prompt multi\nline text'), { name: 'prompt', text: 'multi\nline text' })
  assert.deepEqual(parseCommand('time 07:30'), { name: 'time', value: '07:30' })
  assert.deepEqual(parseCommand('tz Europe/Bratislava'), { name: 'tz', value: 'Europe/Bratislava' })
  assert.deepEqual(parseCommand('voice AF_Bella'), { name: 'voice', value: 'af_bella' })
  assert.deepEqual(parseCommand('top 12'), { name: 'top', value: 12 })
  assert.deepEqual(parseCommand('hours 48'), { name: 'hours', value: 48 })
  for (const w of ['pause', 'stop', 'off']) assert.deepEqual(parseCommand(w), { name: 'pause' })
  for (const w of ['resume', 'on', 'start']) assert.deepEqual(parseCommand(w), { name: 'resume' })
  assert.deepEqual(parseCommand('legacy'), { name: 'format', value: 'nip04' })
  assert.deepEqual(parseCommand('nip17'), { name: 'format', value: 'nip17' })
  assert.deepEqual(parseCommand('digest'), { name: 'digest' })
  assert.deepEqual(parseCommand('pay'), { name: 'pay', plan: 'nalgorithm' })
  assert.deepEqual(parseCommand('pay 5000'), { name: 'pay', plan: 'nalgorithm', sats: 5000 })
  assert.deepEqual(parseCommand('pay all'), { name: 'pay', plan: 'all-access' })
  assert.deepEqual(parseCommand('subscribe all-access 25,000'), { name: 'pay', plan: 'all-access', sats: 25000 })
  assert.deepEqual(parseCommand('delete my data'), { name: 'delete', confirmed: false })
  assert.deepEqual(parseCommand('Delete  my DATA confirm'), { name: 'delete', confirmed: true })
})

test('parser: free text and incomplete commands are never a prompt', () => {
  for (const t of ['I love bitcoin and nostr', 'prompt', 'prompt:', 'time', 'top abc', 'hours', 'delete everything', '', '   ', '🎧']) {
    assert.equal(parseCommand(t).name, 'unknown', JSON.stringify(t))
  }
})

test('prompt, top and hours are validated and saved', async () => {
  const db = await freshDb(); const { d } = deps(db)
  assert.match(await handleCommand(d, NPUB, parseCommand('prompt: bitcoin and nostr')), /Prompt saved.*time 07:30/s)
  assert.equal((await loadSettings(db, NPUB)).userPrompt, 'bitcoin and nostr')
  assert.match(await handleCommand(d, NPUB, parseCommand('top 5')), /top 5/)
  assert.match(await handleCommand(d, NPUB, parseCommand('hours 12')), /12 hours/)
  assert.match(await handleCommand(d, NPUB, parseCommand('top 99')), /^Not changed/)
  assert.match(await handleCommand(d, NPUB, parseCommand('hours 500')), /^Not changed/)
  const s = await loadSettings(db, NPUB)
  assert.equal(s.topN, 5); assert.equal(s.hoursBack, 12)
  assert.match(await handleCommand(d, NPUB, { name: 'prompt', text: 'x'.repeat(2001) }), /^Not changed.*2000/)
})

test('time enables the schedule, tz recomputes it, pause and resume toggle it', async () => {
  const db = await freshDb(); const { d } = deps(db)
  const r = await handleCommand(d, NPUB, parseCommand('time 07:30'))
  assert.match(r, /07:30 UTC/); assert.match(r, /tz Europe\/Bratislava/)
  let s = await loadSchedule(db, NPUB)
  assert.equal(s.enabled, true); assert.equal(s.nextRunAt, Math.floor(Date.parse('2026-09-30T07:30:00Z') / 1000))
  await handleCommand(d, NPUB, parseCommand('tz Europe/Bratislava'))
  s = await loadSchedule(db, NPUB)
  assert.equal(s.nextRunAt, Math.floor(Date.parse('2026-09-30T05:30:00Z') / 1000))
  assert.match(await handleCommand(d, NPUB, parseCommand('pause')), /paused/)
  s = await loadSchedule(db, NPUB); assert.equal(s.enabled, false); assert.equal(s.nextRunAt, null)
  assert.match(await handleCommand(d, NPUB, parseCommand('resume')), /Daily digests on/)
  assert.equal((await loadSchedule(db, NPUB)).enabled, true)
})

test('bad time, zone and voice are refused without changing anything', async () => {
  const db = await freshDb(); const { d } = deps(db)
  assert.match(await handleCommand(d, NPUB, parseCommand('time 25:00')), /^Not changed/)
  assert.match(await handleCommand(d, NPUB, parseCommand('tz Mars/Base')), /^Not changed.*Mars\/Base/)
  assert.match(await handleCommand(d, NPUB, parseCommand('voice not a voice!')), /^Not changed/)
  const s = await loadSchedule(db, NPUB)
  assert.equal(s.enabled, false); assert.equal(s.tz, 'UTC'); assert.equal(s.voice, null)
})

test('format overrides the DM protocol; voice is stored', async () => {
  const db = await freshDb(); const { d } = deps(db)
  await handleCommand(d, NPUB, parseCommand('legacy'))
  assert.equal((await loadSchedule(db, NPUB)).dmFormat, 'nip04')
  await handleCommand(d, NPUB, parseCommand('nip17'))
  assert.equal((await loadSchedule(db, NPUB)).dmFormat, 'nip17')
  await handleCommand(d, NPUB, parseCommand('voice af_bella'))
  assert.equal((await loadSchedule(db, NPUB)).voice, 'af_bella')
})

test('status shows settings and subscription state', async () => {
  const db = await freshDb()
  await saveSettings(db, NPUB, { ...DEFAULT_SETTINGS, userPrompt: 'bitcoin' }, T0)
  const cases = [
    [{ state: 'trial', until: T0 + 86400 }, /free trial until/],
    [{ state: 'active', until: T0 + 86400 * 20 }, /subscribed until/],
    [{ state: 'expired' }, /expired/],
    [{ state: 'none' }, /not started/],
    [{ state: 'unknown' }, /unreachable/],
  ]
  for (const [state, re] of cases) {
    const { d } = deps(db, { state })
    const r = await handleCommand(d, NPUB, parseCommand('status'))
    assert.match(r, /Prompt: bitcoin/); assert.match(r, re)
  }
})

test('pay creates a charge for the sender and returns the link; a billing failure is a friendly message', async () => {
  const db = await freshDb(); const { d, calls } = deps(db)
  assert.match(await handleCommand(d, NPUB, parseCommand('pay')), /10,000 sats.*https:\/\/pay\.example\/i\/i1/s)
  assert.match(await handleCommand(d, NPUB, parseCommand('pay 5000')), /5000 sats/)
  assert.match(await handleCommand(d, NPUB, parseCommand('pay all')), /25,000 sats.*all-access/s)
  assert.deepEqual(calls.charges, [
    { npub: NPUB, plan: 'nalgorithm', sats: undefined },
    { npub: NPUB, plan: 'nalgorithm', sats: 5000 },
    { npub: NPUB, plan: 'all-access', sats: undefined },
  ])
  const failing = deps(db, { chargeFails: true })
  assert.match(await handleCommand(failing.d, NPUB, parseCommand('pay')), /unavailable right now/)
})

test('digest delegates to the job runner', async () => {
  const db = await freshDb(); const { d, calls } = deps(db)
  assert.equal(await handleCommand(d, NPUB, parseCommand('digest')), 'Working on it.')
  assert.deepEqual(calls.digests, [NPUB])
})

test('delete needs confirmation, then erases only that npub', async () => {
  const db = await freshDb(); const { d } = deps(db)
  const OTHER = 'b'.repeat(64)
  for (const n of [NPUB, OTHER]) {
    await saveSettings(db, n, { ...DEFAULT_SETTINGS, userPrompt: 'x' }, T0)
    await saveSchedule(db, { ...DEFAULT_SCHEDULE(n), enabled: true })
    await createStore(db, n).putScores({ e1: { score: 5, createdAt: T0 } })
    await createStore(db, n).putLearned({ prompt: 'p', updatedAt: 't' })
  }
  assert.match(await handleCommand(d, NPUB, parseCommand('delete my data')), /confirm/)
  assert.equal((await loadSettings(db, NPUB)).userPrompt, 'x', 'unconfirmed delete changes nothing')
  assert.match(await handleCommand(d, NPUB, parseCommand('delete my data confirm')), /erased/)
  assert.equal((await loadSettings(db, NPUB)).userPrompt, '')
  assert.equal((await loadSchedule(db, NPUB)).enabled, false)
  assert.deepEqual(await createStore(db, NPUB, () => T0).getScores(['e1']), {})
  assert.equal(await createStore(db, NPUB).getLearned(), null)
  assert.equal((await loadSettings(db, OTHER)).userPrompt, 'x', 'other users are untouched')
  assert.equal((await loadSchedule(db, OTHER)).enabled, true)
  assert.ok(Object.keys(await createStore(db, OTHER, () => T0).getScores(['e1'])).length === 1)
})

test('help text lists every command a user can send', () => {
  for (const w of ['prompt', 'time', 'tz', 'voice', 'top', 'hours', 'digest', 'pause', 'resume', 'status', 'pay', 'legacy', 'nip17', 'delete my data']) assert.ok(HELP.includes(w), w)
})
