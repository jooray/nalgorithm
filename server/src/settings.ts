import type { Db } from './db.js'

export interface UserSettings {
  /** What the user wants to see, in their own words. */
  userPrompt: string
  hoursBack: number
  topN: number
  learnFromLikes: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  userPrompt: '',
  hoursBack: 24,
  topN: 15,
  learnFromLikes: true,
}

export const MAX_PROMPT_CHARS = 2000

export class SettingsError extends Error {}

/** Merge a partial update into `current`, validating every field. */
export function applySettings(current: UserSettings, patch: unknown): UserSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('settings must be an object')
  const p = patch as Record<string, unknown>
  const next = { ...current }
  const allowed = new Set(['userPrompt', 'hoursBack', 'topN', 'learnFromLikes'])
  for (const key of Object.keys(p)) if (!allowed.has(key)) throw new SettingsError(`unknown setting: ${key}`)

  if (p.userPrompt !== undefined) {
    if (typeof p.userPrompt !== 'string') throw new SettingsError('userPrompt must be a string')
    if (p.userPrompt.length > MAX_PROMPT_CHARS) throw new SettingsError(`userPrompt is limited to ${MAX_PROMPT_CHARS} characters`)
    next.userPrompt = p.userPrompt.trim()
  }
  const int = (name: 'hoursBack' | 'topN', min: number, max: number): void => {
    const v = p[name]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new SettingsError(`${name} must be an integer between ${min} and ${max}`)
    }
    next[name] = v
  }
  int('hoursBack', 1, 72)
  int('topN', 1, 30)
  if (p.learnFromLikes !== undefined) {
    if (typeof p.learnFromLikes !== 'boolean') throw new SettingsError('learnFromLikes must be a boolean')
    next.learnFromLikes = p.learnFromLikes
  }
  return next
}

export function loadSettings(db: Db, npub: string): UserSettings {
  const row = db.prepare('SELECT json FROM settings WHERE npub = ?').get(npub) as { json: string } | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.json) as Partial<UserSettings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(db: Db, npub: string, settings: UserSettings, now = Math.floor(Date.now() / 1000)): void {
  db.prepare(
    `INSERT INTO settings (npub, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (npub) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(npub, JSON.stringify(settings), now)
}
