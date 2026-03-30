/**
 * Nalgorithm Web — Settings management (localStorage)
 */

const STORAGE_PREFIX = 'nalgorithm_'

const PROVIDER_URLS: Record<string, string> = {
  venice: 'https://api.venice.ai/api/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  custom: '',
}

export interface AppSettings {
  npub: string
  relays: string[]
  provider: string
  apiBaseUrl: string
  apiKey: string
  model: string
  userPrompt: string
  learnedPrompt: string
  hoursBack: number
  batchSize: number
  njumpBaseUrl: string
}

// ─── Score cache ─────────────────────────────────────────────────────────────
//
// Stored as date-keyed localStorage entries:
//   nalgorithm_scores_2026-03-30  →  { "eventId": { score, justification }, ... }
//
// Pruning removes keys older than 30 days.

export interface CachedScore {
  score: number
  justification?: string
}

/** Max age for cache date-keys before pruning (30 days) */
const CACHE_MAX_AGE_DAYS = 30
const SCORE_CACHE_PREFIX = STORAGE_PREFIX + 'scores_'

/** Today's date as YYYY-MM-DD */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Parse a YYYY-MM-DD string into a Date (midnight UTC). Returns null on failure. */
function parseDateKey(key: string): Date | null {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
}

const DEFAULTS: AppSettings = {
  npub: '',
  relays: [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
  ],
  provider: 'venice',
  apiBaseUrl: 'https://api.venice.ai/api/v1',
  apiKey: '',
  model: 'grok-3-mini',
  userPrompt: '',
  learnedPrompt: '',
  hoursBack: 24,
  batchSize: 20,
  njumpBaseUrl: 'https://njump.me/',
}

function getItem(key: string): string | null {
  return localStorage.getItem(STORAGE_PREFIX + key)
}

function setItem(key: string, value: string): void {
  localStorage.setItem(STORAGE_PREFIX + key, value)
}

/**
 * Load all settings from localStorage, falling back to defaults.
 */
export function loadSettings(): AppSettings {
  return {
    npub: getItem('npub') ?? DEFAULTS.npub,
    relays: parseJsonArray(getItem('relays')) ?? DEFAULTS.relays,
    provider: getItem('provider') ?? DEFAULTS.provider,
    apiBaseUrl: getItem('apiBaseUrl') ?? DEFAULTS.apiBaseUrl,
    apiKey: getItem('apiKey') ?? DEFAULTS.apiKey,
    model: getItem('model') ?? DEFAULTS.model,
    userPrompt: getItem('userPrompt') ?? DEFAULTS.userPrompt,
    learnedPrompt: getItem('learnedPrompt') ?? DEFAULTS.learnedPrompt,
    hoursBack: parseInt(getItem('hoursBack') ?? '', 10) || DEFAULTS.hoursBack,
    batchSize: parseInt(getItem('batchSize') ?? '', 10) || DEFAULTS.batchSize,
    njumpBaseUrl: getItem('njumpBaseUrl') ?? DEFAULTS.njumpBaseUrl,
  }
}

/**
 * Save all settings to localStorage.
 */
export function saveSettings(settings: AppSettings): void {
  setItem('npub', settings.npub)
  setItem('relays', JSON.stringify(settings.relays))
  setItem('provider', settings.provider)
  setItem('apiBaseUrl', settings.apiBaseUrl)
  setItem('apiKey', settings.apiKey)
  setItem('model', settings.model)
  setItem('userPrompt', settings.userPrompt)
  setItem('learnedPrompt', settings.learnedPrompt)
  setItem('hoursBack', String(settings.hoursBack))
  setItem('batchSize', String(settings.batchSize))
  setItem('njumpBaseUrl', settings.njumpBaseUrl)
}

/**
 * Update a single setting.
 */
export function updateSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): void {
  const settings = loadSettings()
  settings[key] = value
  saveSettings(settings)
}

/**
 * Load the full score cache (all date-keys merged into one map).
 */
export function loadScoreCache(): Map<string, CachedScore> {
  const merged = new Map<string, CachedScore>()
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(SCORE_CACHE_PREFIX)) continue
    try {
      const entries: Record<string, CachedScore> = JSON.parse(localStorage.getItem(key)!)
      for (const [id, cached] of Object.entries(entries)) {
        merged.set(id, cached)
      }
    } catch {
      // ignore corrupt entries
    }
  }
  return merged
}

/**
 * Add scored entries to the cache and save (writes to today's date-key).
 */
export function cacheScores(
  entries: Array<{ id: string; score: number; justification?: string }>
): void {
  const key = SCORE_CACHE_PREFIX + todayKey()
  let bucket: Record<string, CachedScore> = {}
  try {
    const raw = localStorage.getItem(key)
    if (raw) bucket = JSON.parse(raw)
  } catch {
    // start fresh
  }
  for (const e of entries) {
    bucket[e.id] = { score: e.score, justification: e.justification }
  }
  localStorage.setItem(key, JSON.stringify(bucket))
}

/**
 * Prune cache date-keys older than 30 days. Returns the number of keys removed.
 */
export function pruneScoreCache(): number {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - CACHE_MAX_AGE_DAYS)

  let removed = 0
  const keysToDelete: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(SCORE_CACHE_PREFIX)) continue
    const dateStr = key.slice(SCORE_CACHE_PREFIX.length)
    const date = parseDateKey(dateStr)
    if (date && date < cutoff) {
      keysToDelete.push(key)
    }
  }

  for (const key of keysToDelete) {
    localStorage.removeItem(key)
    removed++
  }
  return removed
}

/**
 * Clear the entire score cache (all date-keys).
 */
export function clearScoreCache(): void {
  const keysToDelete: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(SCORE_CACHE_PREFIX)) keysToDelete.push(key)
  }
  for (const key of keysToDelete) localStorage.removeItem(key)
}

/**
 * Get the provider URL for a given provider key.
 */
export function getProviderUrl(provider: string): string {
  return PROVIDER_URLS[provider] ?? ''
}

/**
 * Check if settings are valid enough to run.
 */
export function validateSettings(settings: AppSettings): string | null {
  if (!settings.npub.trim()) return 'npub is required'
  if (settings.relays.length === 0) return 'At least one relay is required'
  if (!settings.apiBaseUrl.trim()) return 'API Base URL is required'
  if (!settings.apiKey.trim()) return 'API Key is required'
  if (!settings.model.trim()) return 'Model name is required'
  if (!settings.userPrompt.trim()) return 'User prompt is required — describe your interests'
  return null
}

function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // ignore
  }
  return null
}

export { DEFAULTS, PROVIDER_URLS }
