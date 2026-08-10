/**
 * Nalgorithm Web — model catalog
 *
 * Fetches the provider's model list so the settings fields can offer real
 * choices instead of asking people to remember exact model strings. Typing is
 * still allowed — the list is a `<datalist>`, not a `<select>` — because the
 * catalog is a convenience, not an allowlist, and a provider we can't enumerate
 * must never block you from entering a model by hand.
 */

const CACHE_PREFIX = 'nalgorithm_models_'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface ModelInfo {
  id: string
  contextTokens?: number
  /** USD per million input tokens. */
  inputUsd?: number
  /** USD per million output tokens. */
  outputUsd?: number
}

interface CatalogCache {
  fetchedAt: number
  models: ModelInfo[]
}

export function isVenice(apiBaseUrl: string): boolean {
  return /(^|\/\/|\.)venice\.ai/i.test(apiBaseUrl)
}

/**
 * Models known to work well for each role, best first.
 *
 * A curated list rather than "cheapest" or "biggest context": the scoring model
 * needs to emit strict batched JSON reliably, which price and context do not
 * predict. Only entries actually present in the fetched catalog are offered.
 */
const VENICE_PREFERENCES = {
  scoring: ['deepseek-v4-flash-0731', 'deepseek-v4-flash', 'google-gemma-3-27b-it', 'qwen3-6-27b'],
  digest: ['kimi-k3', 'kimi-k2-6', 'claude-sonnet-5', 'qwen-3-6-plus'],
  learner: ['kimi-k3', 'kimi-k2-6', 'qwen-3-6-plus'],
} as const

export interface SuggestedModels {
  scoring?: string
  digest?: string
  learner?: string
}

/** Pick sensible per-role models from a fetched catalog. Venice only for now. */
export function suggestModels(apiBaseUrl: string, models: ModelInfo[]): SuggestedModels {
  if (!isVenice(apiBaseUrl)) return {}
  const available = new Set(models.map((m) => m.id))
  const first = (list: readonly string[]): string | undefined => list.find((id) => available.has(id))
  return {
    scoring: first(VENICE_PREFERENCES.scoring),
    digest: first(VENICE_PREFERENCES.digest),
    learner: first(VENICE_PREFERENCES.learner),
  }
}

function cacheKey(apiBaseUrl: string): string {
  return CACHE_PREFIX + apiBaseUrl.replace(/\/+$/, '')
}

export function loadCachedModels(apiBaseUrl: string): ModelInfo[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(apiBaseUrl))
    if (!raw) return null
    const cache = JSON.parse(raw) as CatalogCache
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null
    return cache.models
  } catch {
    return null
  }
}

function saveCachedModels(apiBaseUrl: string, models: ModelInfo[]): void {
  try {
    localStorage.setItem(cacheKey(apiBaseUrl), JSON.stringify({ fetchedAt: Date.now(), models }))
  } catch {
    // Quota or private mode — the catalog is disposable.
  }
}

/**
 * Normalize one entry from a provider's `/models` response.
 *
 * Venice nests details under `model_spec`; plain OpenAI-compatible servers
 * (OpenAI, Ollama, most local runners) return little beyond `id`.
 */
function normalize(entry: Record<string, unknown>): ModelInfo | null {
  const id = entry.id
  if (typeof id !== 'string' || !id) return null

  const info: ModelInfo = { id }
  const spec = entry.model_spec as Record<string, unknown> | undefined
  if (spec) {
    const ctx = spec.availableContextTokens
    if (typeof ctx === 'number') info.contextTokens = ctx

    const pricing = spec.pricing as Record<string, unknown> | undefined
    const input = pricing?.input as Record<string, unknown> | undefined
    const output = pricing?.output as Record<string, unknown> | undefined
    if (typeof input?.usd === 'number') info.inputUsd = input.usd
    if (typeof output?.usd === 'number') info.outputUsd = output.usd
  }
  return info
}

/**
 * Fetch the provider's model list.
 *
 * @param force - Skip the local cache.
 */
export async function fetchModels(
  apiBaseUrl: string,
  apiKey: string,
  force = false
): Promise<ModelInfo[]> {
  const base = apiBaseUrl.replace(/\/+$/, '')
  if (!base) throw new Error('Set the API base URL first')

  if (!force) {
    const cached = loadCachedModels(base)
    if (cached) return cached
  }

  // Venice serves text, image, TTS and embedding models from one endpoint;
  // only the text ones are usable here.
  const url = isVenice(base) ? `${base}/models?type=text` : `${base}/models`

  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error('Model list request timed out')
    }
    // A cross-origin failure is the common case for local Ollama.
    throw new Error(
      `Could not reach ${url}. If this is a local server, it may need CORS enabled (Ollama: OLLAMA_ORIGINS=*).`
    )
  }

  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? 'Model list rejected the API key'
        : `Model list failed (HTTP ${res.status})`
    )
  }

  const body = (await res.json()) as { data?: unknown; models?: unknown }
  // `data` is the OpenAI shape; `models` is what a few local servers return.
  const raw = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []

  const models = raw
    .map((e) => normalize(e as Record<string, unknown>))
    .filter((m): m is ModelInfo => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id))

  if (models.length === 0) throw new Error('Provider returned no models')

  saveCachedModels(base, models)
  return models
}

/** A short label for the datalist, e.g. "1M ctx · $0.18/$0.35 per M". */
export function describeModel(model: ModelInfo): string {
  const bits: string[] = []
  if (model.contextTokens) {
    bits.push(
      model.contextTokens >= 1_000_000
        ? `${Math.round(model.contextTokens / 1_000_000)}M ctx`
        : `${Math.round(model.contextTokens / 1000)}k ctx`
    )
  }
  if (model.inputUsd !== undefined && model.outputUsd !== undefined) {
    bits.push(`$${model.inputUsd}/$${model.outputUsd} per M`)
  }
  return bits.join(' · ')
}
