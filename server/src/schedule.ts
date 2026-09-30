import { upsert } from './database.js'
import type { Db } from './db.js'

export interface Schedule {
  npub: string
  enabled: boolean
  hour: number
  minute: number
  tz: string
  voice: string | null
  /** Explicit DM format chosen by the user; null means follow the peer's last message kind. */
  dmFormat: 'nip17' | 'nip04' | null
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
  attempts: number
  expiredNoticeAt: number | null
}

export class ScheduleError extends Error {}

// ─── Time zones ──────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface Parts {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

function partsAt(tz: string, ms: number): Parts {
  const out: Record<string, number> = {}
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second }
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds. */
function offsetMs(tz: string, ms: number): number {
  const p = partsAt(tz, ms)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:mi. The offset is
 * resolved twice so that a time just after a daylight-saving change uses the
 * offset that is in force then, not the one at the first guess.
 */
function zonedToUtcMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const first = guess - offsetMs(tz, guess)
  return guess - offsetMs(tz, first)
}

/**
 * The next unix second (strictly after `nowSec`) at which the clock in `tz`
 * shows hour:minute. Daylight-saving safe: "07:30" stays 07:30 local all year.
 */
export function nextRunAt(nowSec: number, hour: number, minute: number, tz: string): number {
  if (!isValidTimeZone(tz)) throw new ScheduleError(`unknown time zone: ${tz}`)
  const nowMs = nowSec * 1000
  const local = partsAt(tz, nowMs)
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    // Date.UTC normalises day overflow, so this walks calendar days in the zone.
    const base = new Date(Date.UTC(local.y, local.m - 1, local.d + dayOffset))
    const candidate = zonedToUtcMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute, tz)
    if (candidate > nowMs) return Math.floor(candidate / 1000)
  }
  throw new ScheduleError('could not compute the next run time')
}

// ─── Persistence ─────────────────────────────────────────────────────────────

interface Row {
  npub: string
  enabled: number
  hour: number
  minute: number
  tz: string
  voice: string | null
  dm_format: string | null
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  attempts: number
  expired_notice_at: number | null
}

const num = (v: number | null): number | null => (v === null || v === undefined ? null : Number(v))

function fromRow(r: Row): Schedule {
  return {
    npub: r.npub,
    enabled: Number(r.enabled) === 1,
    hour: Number(r.hour),
    minute: Number(r.minute),
    tz: r.tz,
    voice: r.voice,
    dmFormat: r.dm_format === 'nip04' ? 'nip04' : r.dm_format === 'nip17' ? 'nip17' : null,
    nextRunAt: num(r.next_run_at),
    lastRunAt: num(r.last_run_at),
    lastStatus: r.last_status,
    attempts: Number(r.attempts),
    expiredNoticeAt: num(r.expired_notice_at),
  }
}

export const DEFAULT_SCHEDULE = (npub: string): Schedule => ({
  npub,
  enabled: false,
  hour: 7,
  minute: 0,
  tz: 'UTC',
  voice: null,
  dmFormat: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  attempts: 0,
  expiredNoticeAt: null,
})

export async function loadSchedule(db: Db, npub: string): Promise<Schedule> {
  const row = await db.get<Row>('SELECT * FROM schedules WHERE npub = ?', [npub])
  return row ? fromRow(row) : DEFAULT_SCHEDULE(npub)
}

export async function saveSchedule(db: Db, s: Schedule): Promise<void> {
  await db.run(
    upsert(
      db,
      'schedules',
      ['npub', 'enabled', 'hour', 'minute', 'tz', 'voice', 'dm_format', 'next_run_at', 'last_run_at', 'last_status', 'attempts', 'expired_notice_at'],
      ['npub'],
      ['enabled', 'hour', 'minute', 'tz', 'voice', 'dm_format', 'next_run_at', 'last_run_at', 'last_status', 'attempts', 'expired_notice_at'],
    ),
    [s.npub, s.enabled ? 1 : 0, s.hour, s.minute, s.tz, s.voice, s.dmFormat, s.nextRunAt, s.lastRunAt, s.lastStatus, s.attempts, s.expiredNoticeAt],
  )
}

export interface SchedulePatch {
  enabled?: boolean
  /** "HH:MM", 24 hour clock. */
  time?: string
  tz?: string
  voice?: string | null
  dmFormat?: 'nip17' | 'nip04' | null
}

/** Voices accepted for the hosted TTS model. Kokoro voice ids are letters, digits and underscores. */
const VOICE = /^[a-z]{2}_[a-z]{2,16}$/

export function parseTime(text: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim())
  if (!m) throw new ScheduleError('time must look like 07:30')
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new ScheduleError('time must look like 07:30')
  return { hour, minute }
}

/** Apply a validated patch and recompute the next run time. Returns the new schedule (not saved). */
export function applySchedulePatch(current: Schedule, patch: SchedulePatch, nowSec: number): Schedule {
  const next = { ...current }
  if (patch.time !== undefined) {
    const { hour, minute } = parseTime(patch.time)
    next.hour = hour
    next.minute = minute
  }
  if (patch.tz !== undefined) {
    if (!isValidTimeZone(patch.tz)) throw new ScheduleError(`unknown time zone: ${patch.tz} (use a name like Europe/Bratislava)`)
    next.tz = patch.tz
  }
  if (patch.voice !== undefined) {
    if (patch.voice !== null && !VOICE.test(patch.voice)) throw new ScheduleError('unknown voice name')
    next.voice = patch.voice
  }
  if (patch.dmFormat !== undefined) next.dmFormat = patch.dmFormat
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  next.nextRunAt = next.enabled ? nextRunAt(nowSec, next.hour, next.minute, next.tz) : null
  return next
}

/** Schedules whose time has come, oldest first. */
export async function dueSchedules(db: Db, nowSec: number, limit = 20): Promise<Schedule[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?',
    [nowSec, limit],
  )
  return rows.map(fromRow)
}
