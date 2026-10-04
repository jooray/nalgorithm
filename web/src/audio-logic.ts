/**
 * Nalgorithm Web — player logic: speed, resume position, waveform, seeking
 *
 * Pure (storage is passed in), so it runs under plain node for tests.
 * Storage can be blocked or full; every access here is guarded.
 */

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// ─── Speed ───────────────────────────────────────────────────────────────────

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export const DEFAULT_SPEED = 1
const SPEED_KEY = 'nalgorithm_speed'

/** A known speed, or the default for anything else. */
export function normalizeSpeed(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && (SPEEDS as readonly number[]).includes(n) ? n : DEFAULT_SPEED
}

/** "1.25×", "1×", "0.75×". */
export function formatSpeed(speed: number): string {
  return `${speed}×`
}

/** The speed after `current` in the list, wrapping round. */
export function nextSpeed(current: number): number {
  const i = (SPEEDS as readonly number[]).indexOf(current)
  if (i < 0) return DEFAULT_SPEED
  return SPEEDS[(i + 1) % SPEEDS.length]
}

export function loadSpeed(store: KeyValueStore | null): number {
  try {
    return normalizeSpeed(store?.getItem(SPEED_KEY))
  } catch {
    return DEFAULT_SPEED
  }
}

export function saveSpeed(store: KeyValueStore | null, speed: number): void {
  try {
    store?.setItem(SPEED_KEY, String(normalizeSpeed(speed)))
  } catch {
    // not remembered
  }
}

const VOICE_KEY = 'nalgorithm_speech_voice'

/** The browser speech voice chosen in Tune, or '' for the engine default. */
export function loadVoiceName(store: KeyValueStore | null): string {
  try {
    return store?.getItem(VOICE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveVoiceName(store: KeyValueStore | null, name: string): void {
  try {
    if (name) store?.setItem(VOICE_KEY, name)
    else store?.removeItem(VOICE_KEY)
  } catch {
    // not remembered
  }
}

// ─── Resume position and played marks ────────────────────────────────────────

export interface ResumeEntry {
  /** Position in seconds. */
  pos: number
  /** Duration in seconds, 0 when unknown. */
  dur: number
  /** ms since epoch of the last write; used to drop the oldest entries. */
  at: number
  /** The digest was listened to the end. */
  played?: boolean
}

const RESUME_KEY = 'nalgorithm_resume_v1'
const RESUME_MAX_ENTRIES = 100
/** Below this there is nothing worth resuming. */
export const MIN_RESUME_SECONDS = 3
/** This close to the end counts as finished. */
export const END_SLACK_SECONDS = 10

/** Whether the position is so near the end that the next play should start over. */
export function isNearEnd(pos: number, dur: number): boolean {
  return dur > 0 && (dur - pos <= END_SLACK_SECONDS || pos / dur >= 0.97)
}

/** "Resume at 1:23", or null when there is nothing to resume. */
export function resumeHint(pos: number | undefined): string | null {
  if (pos === undefined || pos < MIN_RESUME_SECONDS) return null
  return `Resume at ${formatClock(pos)}`
}

const resumeStates = new WeakMap<KeyValueStore, Record<string, ResumeEntry>>()
export function invalidateResumeStore(store: KeyValueStore | null): void { if (store) resumeStates.delete(store) }
export class ResumeStore {
  private readonly store: KeyValueStore | null

  constructor(store: KeyValueStore | null) {
    this.store = store
  }

  private read(): Record<string, ResumeEntry> {
    if (this.store && resumeStates.has(this.store)) return resumeStates.get(this.store)!
    try {
      const raw = this.store?.getItem(RESUME_KEY)
      const data = raw ? (JSON.parse(raw) as unknown) : null
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
      const out: Record<string, ResumeEntry> = {}
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const e = v as Partial<ResumeEntry> | null
        if (!e || typeof e.pos !== 'number' || !Number.isFinite(e.pos)) continue
        out[k] = {
          pos: Math.max(0, e.pos),
          dur: typeof e.dur === 'number' && Number.isFinite(e.dur) ? Math.max(0, e.dur) : 0,
          at: typeof e.at === 'number' ? e.at : 0,
          ...(e.played ? { played: true } : {}),
        }
      }
      if (this.store) resumeStates.set(this.store, out)
      return out
    } catch {
      return {}
    }
  }

  private write(all: Record<string, ResumeEntry>): void {
    if (this.store) resumeStates.set(this.store, all)
    const keys = Object.keys(all)
    if (keys.length > RESUME_MAX_ENTRIES) {
      keys.sort((a, b) => all[b].at - all[a].at)
      for (const k of keys.slice(RESUME_MAX_ENTRIES)) delete all[k]
    }
    try {
      this.store?.setItem(RESUME_KEY, JSON.stringify(all))
    } catch {
      // not remembered
    }
  }

  get(key: string): ResumeEntry | undefined {
    return this.read()[key]
  }

  /** The position to resume from, or 0 (nothing saved, too early, or finished). */
  resumeAt(key: string): number {
    const e = this.get(key)
    if (!e || e.pos < MIN_RESUME_SECONDS || isNearEnd(e.pos, e.dur)) return 0
    return e.pos
  }

  isPlayed(key: string): boolean {
    return this.get(key)?.played === true
  }

  /** Known duration for a digest, 0 when never loaded. */
  durationOf(key: string): number {
    return this.get(key)?.dur ?? 0
  }

  /**
   * Save the position. Near the end it is cleared instead (and the digest is
   * marked played), so the next play starts from the top.
   */
  save(key: string, pos: number, dur: number, now = Date.now()): void {
    const all = this.read()
    const prev = all[key]
    const keepPlayed = prev?.played ? { played: true as const } : {}
    if (isNearEnd(pos, dur)) {
      all[key] = { pos: 0, dur, at: now, played: true }
    } else if (pos < MIN_RESUME_SECONDS) {
      all[key] = { pos: 0, dur: dur || prev?.dur || 0, at: now, ...keepPlayed }
    } else {
      all[key] = { pos, dur: dur || prev?.dur || 0, at: now, ...keepPlayed }
    }
    this.write(all)
  }

  /** Record only the duration (metadata loaded) without touching the position. */
  saveDuration(key: string, dur: number, now = Date.now()): void {
    if (!(dur > 0)) return
    const all = this.read()
    const prev = all[key]
    all[key] = { pos: prev?.pos ?? 0, dur, at: prev?.at ?? now, ...(prev?.played ? { played: true } : {}) }
    this.write(all)
  }

  markPlayed(key: string, dur = 0, now = Date.now()): void {
    const all = this.read()
    all[key] = { pos: 0, dur: dur || all[key]?.dur || 0, at: now, played: true }
    this.write(all)
  }
}

// ─── Clock, waveform, seeking ────────────────────────────────────────────────

/** "m:ss", or "h:mm:ss" from an hour up. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const rr = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rr}` : `${m}:${rr}`
}

/**
 * A fixed pseudo-random bar pattern (heights 0.12 to 1), the same on every
 * load: it is a picture of a voice, not a measurement of this file.
 */
export function waveformBars(count: number, seed = 0x6b3df5): number[] {
  let a = seed >>> 0
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const bars: number[] = []
  let envelope = 0.5
  for (let i = 0; i < count; i++) {
    // A slow drifting envelope with fast jitter reads as speech.
    envelope = Math.min(1, Math.max(0.25, envelope + (rand() - 0.5) * 0.35))
    const h = envelope * (0.55 + rand() * 0.45)
    bars.push(Math.min(1, Math.max(0.12, h)))
  }
  return bars
}

/** Position in 0..1 for a pointer at `x` over an element at `left` with `width`. */
export function fractionFromPointer(x: number, left: number, width: number): number {
  if (!(width > 0)) return 0
  return Math.min(1, Math.max(0, (x - left) / width))
}

/** Move a position by `delta` seconds inside 0..duration. */
export function clampSeek(pos: number, delta: number, duration: number): number {
  const target = pos + delta
  return Math.min(duration > 0 ? duration : Infinity, Math.max(0, target))
}
