import { upsert } from './database.js'
import type { Db } from './db.js'
import { FEEDBACK_EXCERPT_MAX, FEEDBACK_RULES_MAX, type FeedbackRule } from 'nalgorithm'

export interface UserSettings {
  /** What the user wants to see, in their own words. */
  userPrompt: string
  hoursBack: number
  topN: number
  learnFromLikes: boolean
  /** Show link cards under posts. The server fetches the pages, so this is the reader's choice. */
  linkPreviews: boolean
  /** Target spoken digest length: 3, 6 or 10 minutes; an upper bound, never padded to. */
  digestMinutes: number
  /** Private "more/less like this" rules, newest first. Never published; they steer future scores. */
  feedback: FeedbackRule[]
}

export const DIGEST_MINUTES = [3, 6, 10] as const

export const DEFAULT_SETTINGS: UserSettings = {
  userPrompt: '',
  hoursBack: 24,
  topN: 15,
  learnFromLikes: true,
  linkPreviews: true,
  digestMinutes: 6,
  feedback: [],
}

export const MAX_PROMPT_CHARS = 2000

export class SettingsError extends Error {}

/** Merge a partial update into `current`, validating every field. */
export function applySettings(current: UserSettings, patch: unknown): UserSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('settings must be an object')
  const p = patch as Record<string, unknown>
  const next = { ...current }
  const allowed = new Set(['userPrompt', 'hoursBack', 'topN', 'learnFromLikes', 'linkPreviews', 'digestMinutes', 'feedback'])
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
  if (p.linkPreviews !== undefined) {
    if (typeof p.linkPreviews !== 'boolean') throw new SettingsError('linkPreviews must be a boolean')
    next.linkPreviews = p.linkPreviews
  }
  if (p.feedback !== undefined) {
    const list = p.feedback
    if (!Array.isArray(list) || list.length > FEEDBACK_RULES_MAX) throw new SettingsError(`feedback must be a list of at most ${FEEDBACK_RULES_MAX} rules`)
    next.feedback = list.map((r: unknown) => {
      const rule = r as Partial<FeedbackRule> | null
      if (!rule || (rule.kind !== 'more' && rule.kind !== 'less') || typeof rule.excerpt !== 'string' || !rule.excerpt.trim() || rule.excerpt.length > FEEDBACK_EXCERPT_MAX) {
        throw new SettingsError(`each feedback rule needs kind more or less and an excerpt of 1 to ${FEEDBACK_EXCERPT_MAX} characters`)
      }
      return { kind: rule.kind, excerpt: rule.excerpt.trim() }
    })
  }
  if (p.digestMinutes !== undefined) {
    if (!(DIGEST_MINUTES as readonly unknown[]).includes(p.digestMinutes)) throw new SettingsError('digestMinutes must be 3, 6 or 10')
    next.digestMinutes = p.digestMinutes as number
  }
  return next
}

export async function loadSettings(db: Db, npub: string): Promise<UserSettings> {
  const row = await db.get<{ data: string }>('SELECT data FROM settings WHERE npub = ?', [npub])
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.data) as Partial<UserSettings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(db: Db, npub: string, settings: UserSettings, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.run(upsert(db, 'settings', ['npub', 'data', 'updated_at'], ['npub'], ['data', 'updated_at']), [npub, JSON.stringify(settings), now])
}
