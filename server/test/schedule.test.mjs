import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../dist/db.js'
import { applySchedulePatch, DEFAULT_SCHEDULE, dueSchedules, isValidTimeZone, loadSchedule, nextRunAt, parseTime, saveSchedule, ScheduleError } from '../dist/schedule.js'

const utc = (s) => Math.floor(Date.parse(s) / 1000)

let shared
after(async () => { await shared?.close() })
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  await shared.exec('DELETE FROM schedules')
  return shared
}

test('nextRunAt: same day when the time is still ahead, next day when it has passed', () => {
  // Bratislava is UTC+2 in September: 07:00 local = 05:00Z
  assert.equal(nextRunAt(utc('2026-09-30T03:00:00Z'), 7, 0, 'Europe/Bratislava'), utc('2026-09-30T05:00:00Z'))
  assert.equal(nextRunAt(utc('2026-09-30T05:00:00Z'), 7, 0, 'Europe/Bratislava'), utc('2026-10-01T05:00:00Z'), 'exactly now counts as passed')
  assert.equal(nextRunAt(utc('2026-09-30T09:00:00Z'), 7, 0, 'Europe/Bratislava'), utc('2026-10-01T05:00:00Z'))
})

test('nextRunAt: 07:30 stays 07:30 local across the autumn daylight-saving change', () => {
  // Europe clocks go back at 03:00 local on 2026-10-25 (UTC+2 -> UTC+1), so from
  // the afternoon of the 24th the next 07:30 local is already at +1: 06:30Z.
  assert.equal(nextRunAt(utc('2026-10-24T08:00:00Z'), 7, 30, 'Europe/Bratislava'), utc('2026-10-25T06:30:00Z'))
})

test('nextRunAt: exact offsets on both sides of the change', () => {
  assert.equal(nextRunAt(utc('2026-10-24T00:00:00Z'), 7, 30, 'Europe/Bratislava'), utc('2026-10-24T05:30:00Z'))
  assert.equal(nextRunAt(utc('2026-10-25T00:00:00Z'), 7, 30, 'Europe/Bratislava'), utc('2026-10-25T06:30:00Z'))
})

test('nextRunAt: spring change and a zone with a half-hour offset', () => {
  // Europe clocks go forward on 2026-03-29 (UTC+1 -> UTC+2)
  assert.equal(nextRunAt(utc('2026-03-28T12:00:00Z'), 7, 0, 'Europe/Bratislava'), utc('2026-03-29T05:00:00Z'))
  assert.equal(nextRunAt(utc('2026-09-30T00:00:00Z'), 7, 0, 'Asia/Kolkata'), utc('2026-09-30T01:30:00Z'))
  assert.equal(nextRunAt(utc('2026-01-15T00:00:00Z'), 7, 0, 'America/New_York'), utc('2026-01-15T12:00:00Z'))
})

test('nextRunAt: a time that does not exist (spring gap) still returns a later instant, not a crash', () => {
  const r = nextRunAt(utc('2026-03-28T12:00:00Z'), 2, 30, 'Europe/Bratislava')
  assert.ok(r > utc('2026-03-28T12:00:00Z') && r < utc('2026-03-30T00:00:00Z'))
})

test('time zone and time validation', () => {
  assert.equal(isValidTimeZone('Europe/Bratislava'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  for (const bad of ['', 'Mars/Base', 'x'.repeat(65), null]) assert.equal(isValidTimeZone(bad), false)
  assert.deepEqual(parseTime('7:05'), { hour: 7, minute: 5 })
  assert.deepEqual(parseTime('07.30'), { hour: 7, minute: 30 })
  for (const bad of ['24:00', '07:60', 'seven', '7', '07:3']) assert.throws(() => parseTime(bad), ScheduleError, bad)
  assert.throws(() => nextRunAt(0, 7, 0, 'Mars/Base'), ScheduleError)
})

test('applySchedulePatch validates and recomputes the next run; disabling clears it', () => {
  const now = utc('2026-09-30T03:00:00Z')
  const s = applySchedulePatch(DEFAULT_SCHEDULE('a'.repeat(64)), { time: '07:30', tz: 'Europe/Bratislava', enabled: true, voice: 'af_bella' }, now)
  assert.equal(s.enabled, true)
  assert.equal(s.nextRunAt, utc('2026-09-30T05:30:00Z'))
  assert.equal(s.voice, 'af_bella')
  assert.equal(applySchedulePatch(s, { enabled: false }, now).nextRunAt, null)
  assert.throws(() => applySchedulePatch(s, { tz: 'Nope/Zone' }, now), ScheduleError)
  assert.throws(() => applySchedulePatch(s, { voice: 'BAD VOICE!' }, now), ScheduleError)
  assert.equal(applySchedulePatch(s, { voice: null }, now).voice, null)
  assert.equal(applySchedulePatch(s, { dmFormat: 'nip04' }, now).dmFormat, 'nip04')
})

test('schedules persist and only due, enabled ones are returned oldest first', async () => {
  const db = await freshDb()
  const now = utc('2026-09-30T05:00:00Z')
  const mk = (c, patch) => applySchedulePatch(DEFAULT_SCHEDULE(c.repeat(64)), { time: '07:00', tz: 'Europe/Bratislava', ...patch }, now - 86400)
  const a = { ...mk('a', { enabled: true }), nextRunAt: now - 100 }
  const b = { ...mk('b', { enabled: true }), nextRunAt: now - 500 }
  const c = { ...mk('c', { enabled: true }), nextRunAt: now + 500 }
  const d = { ...mk('d', { enabled: false }), nextRunAt: now - 900 }
  for (const s of [a, b, c, d]) await saveSchedule(db, s)
  const due = await dueSchedules(db, now)
  assert.deepEqual(due.map((s) => s.npub[0]), ['b', 'a'])
  const loaded = await loadSchedule(db, 'a'.repeat(64))
  assert.equal(loaded.tz, 'Europe/Bratislava')
  assert.equal(loaded.enabled, true)
  assert.equal((await loadSchedule(db, 'z'.repeat(64))).enabled, false, 'unknown npub gets the default')
  await saveSchedule(db, { ...a, lastStatus: 'ok', attempts: 2 })
  assert.equal((await loadSchedule(db, 'a'.repeat(64))).attempts, 2, 'save updates in place')
})
