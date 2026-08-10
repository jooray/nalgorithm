/**
 * Nalgorithm Web — Settings management (localStorage)
 */

import { DEFAULT_SIGNER_RELAYS } from './nostr-login.js'
import { presetFromUrl, type ClientPreset } from './client-url.js'

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
  /** Model for digest writing. Falls back to `model` when blank. */
  digestModel: string
  /** Model for learning from likes. Falls back to `model` when blank. */
  learnerModel: string
  /** Number of top posts fed to the digest. */
  digestTopN: number
  /** Add text-to-speech phrasing rules to the digest prompt. */
  digestForSpeech: boolean
  /** Relays used for the NIP-46 remote-signer handshake. */
  signerRelays: string[]
  userPrompt: string
  learnedPrompt: string
  hoursBack: number
  batchSize: number
  /** Scoring batches to run in parallel. 1 = sequential. */
  concurrency: number
  /** Which Nostr client to open posts in. */
  clientPreset: ClientPreset
  /** Custom URL template, used when clientPreset is 'custom'. */
  clientCustomUrl: string
  /** Automatically load the feed on page open when settings are complete. */
  autoRefresh: boolean
  /** TTS model for downloadable audio (e.g. tts-kokoro). Blank disables download. */
  ttsModel: string
  /** Voice id for the TTS model. */
  ttsVoice: string
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
  // Cheap, fast, and reliable at the batched-JSON scoring this app does.
  // Keep this pointing at a model that is actually live in the provider's
  // catalog — a delisted default makes the first run fail for every new user.
  model: 'deepseek-v4-flash-0731',
  // Blank means "reuse the scoring model". A digest runs once over ~15 posts,
  // so a stronger model here costs little; scoring is the expensive part.
  digestModel: '',
  learnerModel: '',
  digestTopN: 15,
  digestForSpeech: true,
  signerRelays: [...DEFAULT_SIGNER_RELAYS],
  userPrompt: '',
  learnedPrompt: '',
  hoursBack: 24,
  batchSize: 20,
  concurrency: 1,
  clientPreset: 'njump',
  clientCustomUrl: '',
  autoRefresh: true,
  ttsModel: '',
  ttsVoice: '',
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
    digestModel: getItem('digestModel') ?? DEFAULTS.digestModel,
    learnerModel: getItem('learnerModel') ?? DEFAULTS.learnerModel,
    digestTopN: parseInt(getItem('digestTopN') ?? '', 10) || DEFAULTS.digestTopN,
    digestForSpeech: (getItem('digestForSpeech') ?? String(DEFAULTS.digestForSpeech)) === 'true',
    signerRelays: parseJsonArray(getItem('signerRelays')) ?? DEFAULTS.signerRelays,
    userPrompt: getItem('userPrompt') ?? DEFAULTS.userPrompt,
    learnedPrompt: getItem('learnedPrompt') ?? DEFAULTS.learnedPrompt,
    hoursBack: parseInt(getItem('hoursBack') ?? '', 10) || DEFAULTS.hoursBack,
    batchSize: parseInt(getItem('batchSize') ?? '', 10) || DEFAULTS.batchSize,
    concurrency: parseInt(getItem('concurrency') ?? '', 10) || DEFAULTS.concurrency,
    clientPreset: readClientPreset(),
    clientCustomUrl: getItem('clientCustomUrl') ?? readLegacyCustomUrl(),
    autoRefresh: (getItem('autoRefresh') ?? String(DEFAULTS.autoRefresh)) === 'true',
    ttsModel: getItem('ttsModel') ?? DEFAULTS.ttsModel,
    ttsVoice: getItem('ttsVoice') ?? DEFAULTS.ttsVoice,
  }
}

/**
 * Resolve the client choice, migrating the older `njumpBaseUrl` setting.
 *
 * That key held a bare prefix, so an existing user who had pointed it at
 * Primal keeps Primal instead of being silently reset to njump.
 */
function readClientPreset(): ClientPreset {
  const stored = getItem('clientPreset')
  if (stored) return stored as ClientPreset
  const legacy = getItem('njumpBaseUrl')
  return legacy ? presetFromUrl(legacy) : DEFAULTS.clientPreset
}

function readLegacyCustomUrl(): string {
  const legacy = getItem('njumpBaseUrl')
  return legacy && presetFromUrl(legacy) === 'custom' ? legacy : DEFAULTS.clientCustomUrl
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
  setItem('digestModel', settings.digestModel)
  setItem('learnerModel', settings.learnerModel)
  setItem('digestTopN', String(settings.digestTopN))
  setItem('digestForSpeech', String(settings.digestForSpeech))
  setItem('signerRelays', JSON.stringify(settings.signerRelays))
  setItem('userPrompt', settings.userPrompt)
  setItem('learnedPrompt', settings.learnedPrompt)
  setItem('hoursBack', String(settings.hoursBack))
  setItem('batchSize', String(settings.batchSize))
  setItem('concurrency', String(settings.concurrency))
  setItem('clientPreset', settings.clientPreset)
  setItem('clientCustomUrl', settings.clientCustomUrl)
  setItem('autoRefresh', String(settings.autoRefresh))
  setItem('ttsModel', settings.ttsModel)
  setItem('ttsVoice', settings.ttsVoice)
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
