/**
 * Nalgorithm Web — Settings management (localStorage)
 */

import { DEFAULT_SIGNER_RELAYS } from './nostr-login.js'
import { pubkeyToHex, rankingContext } from 'nalgorithm'
import { deviceStorage as localStorage, storageNotice } from './storage.js'
import { setupProblem } from './settings-validation.js'
import { isClientPreset, presetFromUrl, validateTemplate, type ClientPreset } from './client-url.js'

const STORAGE_PREFIX = 'nalgorithm_'

const PROVIDER_URLS: Record<string, string> = {
  venice: 'https://api.venice.ai/api/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  custom: '',
}

export interface AppSettings {
  learnFromLikes: boolean
  rememberKey: boolean
  feedOrder: 'new' | 'best'
  dataSaver: boolean
  digestMinutes: number
  npub: string
  relays: string[]
  provider: string
  apiBaseUrl: string
  apiKey: string
  model: string
  /**
   * How posts are scored: `chat` uses `model`, `decision` uses
   * `decisionModel` on the provider's `/decisions` endpoint (Venice only).
   */
  scorer: 'chat' | 'decision'
  /** Decision model used when `scorer` is `decision`. */
  decisionModel: string
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
  /** Custom profile URL template ({npub}, {nprofile}, {pubkey}), used when clientPreset is 'custom'. */
  clientCustomProfileUrl: string
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
  /** Which scorer produced it; absent means chat, as every older entry was. */
  scorer?: 'decision'
}

export function scoreNamespace(settings: AppSettings): string {
  let identity = settings.npub.trim()
  try { identity = pubkeyToHex(identity) } catch { /* validation reports malformed identity */ }
  return `${identity}_${rankingContext({ ...settings, model: settings.scorer === 'decision' ? settings.decisionModel : settings.model })}_`
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
  learnFromLikes: true,
  rememberKey: true,
  feedOrder: 'new',
  dataSaver: false,
  digestMinutes: 6,
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
  scorer: 'chat',
  decisionModel: 'jev-latest',
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
  clientCustomProfileUrl: '',
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
    learnFromLikes: getItem('learnFromLikes') !== 'false',
    rememberKey: getItem('rememberKey') !== 'false',
    feedOrder: getItem('feedOrder') === 'best' ? 'best' : 'new',
    dataSaver: getItem('dataSaver') === 'true',
    digestMinutes: Number(getItem('digestMinutes')) || 6,
    npub: getItem('npub') ?? DEFAULTS.npub,
    relays: parseJsonArray(getItem('relays')) ?? DEFAULTS.relays,
    provider: getItem('provider') ?? DEFAULTS.provider,
    apiBaseUrl: getItem('apiBaseUrl') ?? DEFAULTS.apiBaseUrl,
    apiKey: getItem('rememberKey') === 'false' ? sessionKey : getItem('apiKey') ?? DEFAULTS.apiKey,
    model: getItem('model') ?? DEFAULTS.model,
    scorer: getItem('scorer') === 'decision' ? 'decision' : 'chat',
    decisionModel: getItem('decisionModel') || DEFAULTS.decisionModel,
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
    clientCustomProfileUrl: getItem('clientCustomProfileUrl') ?? DEFAULTS.clientCustomProfileUrl,
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
  if (isClientPreset(stored)) return stored
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
export function saveSettings(settings: AppSettings): string {
  setItem('learnFromLikes', String(settings.learnFromLikes))
  setItem('rememberKey', String(settings.rememberKey))
  setItem('feedOrder', settings.feedOrder)
  setItem('dataSaver', String(settings.dataSaver))
  setItem('digestMinutes', String(settings.digestMinutes))
  setItem('npub', settings.npub)
  setItem('relays', JSON.stringify(settings.relays))
  setItem('provider', settings.provider)
  setItem('apiBaseUrl', settings.apiBaseUrl)
  if (settings.rememberKey) setItem('apiKey', settings.apiKey)
  else { localStorage.removeItem(STORAGE_PREFIX + 'apiKey'); sessionKey = settings.apiKey }
  setItem('model', settings.model)
  setItem('scorer', settings.scorer)
  setItem('decisionModel', settings.decisionModel)
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
  setItem('clientCustomProfileUrl', settings.clientCustomProfileUrl)
  setItem('autoRefresh', String(settings.autoRefresh))
  setItem('ttsModel', settings.ttsModel)
  setItem('ttsVoice', settings.ttsVoice)
  return storageNotice()
}

let sessionKey = ''
export function saveProviderDraft(provider: string, fields: Pick<AppSettings, 'apiBaseUrl' | 'apiKey' | 'model' | 'digestModel' | 'learnerModel'>): void {
  const { apiKey: _key, ...safe } = fields
  setItem(`provider_${provider}`, JSON.stringify(safe))
}
export function providerDraft(provider: string): Pick<AppSettings, 'apiBaseUrl' | 'model' | 'digestModel' | 'learnerModel'> {
  const defaults = { apiBaseUrl: PROVIDER_URLS[provider] ?? '', model: provider === 'ollama' ? 'llama3.2' : provider === 'openrouter' ? 'google/gemma-3-27b-it' : provider === 'custom' ? '' : DEFAULTS.model, digestModel: '', learnerModel: '' }
  try { return { ...defaults, ...JSON.parse(getItem(`provider_${provider}`) ?? '{}') } } catch { return defaults }
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
export function loadScoreCache(settings = loadSettings()): Map<string, CachedScore> {
  const prefix = SCORE_CACHE_PREFIX + scoreNamespace(settings)
  const merged = new Map<string, CachedScore>()
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(prefix)) continue
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
  entries: Array<{ id: string; score: number; justification?: string; scorer?: 'decision' }>,
  settings = loadSettings()
): void {
  const key = SCORE_CACHE_PREFIX + scoreNamespace(settings) + todayKey()
  let bucket: Record<string, CachedScore> = {}
  try {
    const raw = localStorage.getItem(key)
    if (raw) bucket = JSON.parse(raw)
  } catch {
    // start fresh
  }
  for (const e of entries) {
    bucket[e.id] = { score: e.score, justification: e.justification, ...(e.scorer ? { scorer: e.scorer } : {}) }
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
    const dateStr = key.slice(-10)
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
  const problem = setupProblem(settings)
  if (problem) return problem.message
  if (settings.clientPreset === 'custom') {
    const bad = validateTemplate(settings.clientCustomUrl) ?? validateTemplate(settings.clientCustomProfileUrl)
    if (bad) return `Custom client links: ${bad}`
  }
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
