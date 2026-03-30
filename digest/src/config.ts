/**
 * Nalgorithm Digest — Configuration loader
 *
 * Loads config from a JSON file (path from CLI arg or default ./digest.config.json).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ApiConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
}

export interface DigestConfig {
  npub: string
  relays: string[]
  rankingApi: ApiConfig & {
    batchSize?: number
  }
  digestApi: ApiConfig & {
    temperature?: number
  }
  /** Optional separate LLM for preference learning. Falls back to rankingApi if not set. */
  learnerApi?: ApiConfig
  userPrompt: string
  learnFromLikes?: boolean
  /** Path to the learned prompt file (default: ./digest.learned.json) */
  learnedPromptCache?: string
  /** Path to score cache file (default: ./digest.scores.json) */
  scoreCachePath?: string
  hoursBack?: number
  topN?: number
  digestSystemPrompt?: string
  digestPrompt?: string
}

const DEFAULT_DIGEST_SYSTEM_PROMPT = `You are a witty, knowledgeable radio host delivering a spoken-word digest of what happened on Nostr in the last 24 hours. Always open with "Good morning, nostrich!" Your style is conversational, warm, and engaging — like a smart friend catching you up over coffee. You weave posts together into a narrative rather than reading them one by one. Add context, make connections between topics, and keep the energy up. Aim for 5-10 minutes of spoken content (roughly 1000-2000 words).`

const DEFAULT_DIGEST_PROMPT = `Create a spoken-word radio digest from these top Nostr posts. Group related topics together, add transitions, and make it flow naturally as if someone is listening to it being read aloud. Don't just list posts — tell the story of what happened today. Include attribution (mention who said what) but keep it natural. Skip any posts that are too short or low-quality to be worth mentioning.`

/**
 * Interpolate $ENV_VAR and ${ENV_VAR} references in string values.
 * Supports the pattern: "$VAR_NAME" or "${VAR_NAME}" anywhere in a string.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const varName = braced ?? bare
    const envValue = process.env[varName]
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set (referenced in config)`)
    }
    return envValue
  })
}

/**
 * Recursively walk a parsed JSON value and interpolate env vars in all strings.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return interpolateEnv(obj)
  if (Array.isArray(obj)) return obj.map(interpolateDeep)
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateDeep(v)
    }
    return result
  }
  return obj
}

/**
 * Load and validate the digest config from a JSON file.
 * String values can reference environment variables with $VAR or ${VAR} syntax.
 */
export function loadConfig(path?: string): DigestConfig {
  const configPath = resolve(path ?? process.argv[2] ?? './digest.config.json')

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `Config file not found: ${configPath}\n\nCopy digest.config.example.json to digest.config.json and fill in your settings.`
      : `Failed to read config file ${configPath}: ${(err as Error).message}`
    throw new Error(msg)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`)
  }

  // Interpolate env vars in all string values
  const config = interpolateDeep(parsed) as Record<string, unknown>

  // Validate required fields
  if (!config.npub || typeof config.npub !== 'string' || config.npub === 'npub1...') {
    throw new Error('Config: "npub" is required — set it to your Nostr npub')
  }

  if (!Array.isArray(config.relays) || config.relays.length === 0) {
    throw new Error('Config: "relays" must be a non-empty array of relay URLs')
  }

  const rankingApi = config.rankingApi as Record<string, unknown> | undefined
  if (!rankingApi?.apiBaseUrl || !rankingApi?.apiKey || !rankingApi?.model) {
    throw new Error('Config: "rankingApi" requires apiBaseUrl, apiKey, and model')
  }

  const digestApi = config.digestApi as Record<string, unknown> | undefined
  if (!digestApi?.apiBaseUrl || !digestApi?.apiKey || !digestApi?.model) {
    throw new Error('Config: "digestApi" requires apiBaseUrl, apiKey, and model')
  }

  if (!config.userPrompt || typeof config.userPrompt !== 'string') {
    throw new Error('Config: "userPrompt" is required — describe your interests')
  }

  // Parse optional learnerApi (falls back to rankingApi in main.ts)
  const learnerApi = config.learnerApi as Record<string, unknown> | undefined
  const parsedLearnerApi = (learnerApi?.apiBaseUrl && learnerApi?.apiKey && learnerApi?.model)
    ? {
        apiBaseUrl: learnerApi.apiBaseUrl as string,
        apiKey: learnerApi.apiKey as string,
        model: learnerApi.model as string,
      }
    : undefined

  return {
    npub: config.npub as string,
    relays: config.relays as string[],
    rankingApi: {
      apiBaseUrl: rankingApi.apiBaseUrl as string,
      apiKey: rankingApi.apiKey as string,
      model: rankingApi.model as string,
      batchSize: (rankingApi.batchSize as number) ?? 20,
    },
    digestApi: {
      apiBaseUrl: digestApi.apiBaseUrl as string,
      apiKey: digestApi.apiKey as string,
      model: digestApi.model as string,
      temperature: (digestApi.temperature as number) ?? 0.7,
    },
    learnerApi: parsedLearnerApi,
    userPrompt: config.userPrompt as string,
    learnFromLikes: (config.learnFromLikes as boolean) ?? true,
    learnedPromptCache: (config.learnedPromptCache as string) ?? './digest.learned.json',
    scoreCachePath: (config.scoreCachePath as string) ?? './digest.scores.json',
    hoursBack: (config.hoursBack as number) ?? 24,
    topN: (config.topN as number) ?? 15,
    digestSystemPrompt: (config.digestSystemPrompt as string) ?? DEFAULT_DIGEST_SYSTEM_PROMPT,
    digestPrompt: (config.digestPrompt as string) ?? DEFAULT_DIGEST_PROMPT,
  }
}
