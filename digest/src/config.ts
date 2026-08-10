/**
 * Nalgorithm Digest — Configuration loader
 *
 * Loads config from a JSON file (path from CLI arg or default ./digest.config.json).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TTSConfig } from 'nalgorithm'

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
    /**
     * Number of scoring batches to run in parallel (default: 1 = sequential).
     * Set to 3-5 for significantly faster scoring. Be mindful of API rate limits.
     */
    concurrency?: number
  }
  digestApi: ApiConfig & {
    temperature?: number
  }
  /**
   * Optional fallback LLM for digest generation.
   * Used when digestApi fails (e.g. 429 overload) after all retries are exhausted.
   * Can use a different provider and/or model.
   * If not set, digest generation will fail without a fallback.
   */
  digestFallbackApi?: ApiConfig & {
    temperature?: number
  }
  /** Optional separate LLM for preference learning. Falls back to rankingApi if not set. */
  learnerApi?: ApiConfig
  userPrompt: string
  learnFromLikes?: boolean
  /**
   * How many likes to include per summarization batch (default: 50).
   * Larger values may hit context limits on some models.
   */
  likesBatchSize?: number
  /** Path to the learned prompt file (default: ./digest.learned.json) */
  learnedPromptCache?: string
  /** Path to score cache file (default: ./digest.scores.json) */
  scoreCachePath?: string
  /** How many days to keep cached scores. Defaults to 90. Scores are deterministic so long TTLs are fine. */
  scoreCacheTTLDays?: number
  hoursBack?: number
  /** Maximum number of posts to fetch (default: 500) */
  maxPosts?: number
  topN?: number
  digestSystemPrompt?: string
  digestPrompt?: string
  /**
   * Optional text-to-speech settings. When set (and `--tts` is passed or
   * `ttsOutputPath` is configured), the finished digest is also synthesized
   * to an audio file. Works with any OpenAI-compatible `/audio/speech`
   * endpoint, e.g. Venice's `tts-kokoro`.
   */
  ttsApi?: TTSConfig
  /**
   * Where to write the synthesized audio. Supports `strftime`-like tokens
   * `%Y`, `%m`, `%d`, `%H`, `%M`, `%S` so each run gets its own file.
   * Passing a path to `--tts` overrides this.
   */
  ttsOutputPath?: string
}

const DEFAULT_DIGEST_SYSTEM_PROMPT = `You are a witty, knowledgeable radio host delivering a spoken-word digest of what happened on Nostr in the last 24 hours. Always open with "Good morning, nostrich!" Your style is conversational, warm, and engaging — like a smart friend catching you up over coffee. You weave posts together into a narrative rather than reading them one by one. Add context, make connections between topics, and keep the energy up. Aim for 5-10 minutes of spoken content (roughly 1000-2000 words).`

const DEFAULT_DIGEST_PROMPT = `Create a spoken-word radio digest from these top Nostr posts. Group related topics together, add transitions, and make it flow naturally as if someone is listening to it being read aloud. Don't just list posts — tell the story of what happened today. Include attribution (mention who said what) but keep it natural. Skip any posts that are too short or low-quality to be worth mentioning.`

/**
 * Humanizer rules — always appended to the system prompt.
 * Prevents the most common AI writing tells in voice output.
 * Based on https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 */
const HUMANIZER_APPENDIX = `
WRITING STYLE (mandatory — apply before finalizing):
- No significance inflation: avoid "pivotal", "testament", "evolving landscape", "underscores", "enduring"
- No promotional language: avoid "groundbreaking", "vibrant", "stunning", "nestled", "breathtaking"
- No vague attributions: avoid "experts believe", "observers note", "industry reports suggest"
- No superficial -ing phrases tacked on for fake depth: avoid "highlighting...", "showcasing...", "reflecting...", "contributing to..."
- No em dash overuse — prefer commas or short sentences
- No staccato "Not X. Not Y." contrast pattern
- No copula avoidance: use "is"/"are" instead of "serves as", "stands as", "functions as"
- No filler: cut "In order to", "At this point in time", "It is important to note that"
- No generic upbeat conclusions: avoid "the future looks bright", "exciting times ahead", "continuing this journey"
- No rule of three where it feels forced
- Vary sentence length. Short punchy ones. Then longer ones that take their time. Mix them.
- Have opinions. React to things. Be specific rather than vague.`

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
/** Flags that consume the argument after them, so it is not the config path. */
const VALUE_FLAGS = new Set(['--tts'])

export interface ParsedArgs {
  /** First positional argument, if any — the config file path. */
  configPath?: string
  /** `--score-only`: refresh the score cache and exit without generating a digest. */
  scoreOnly: boolean
  /**
   * `--tts [path]`: an explicit output path, `true` for the bare flag
   * (use `ttsOutputPath` from the config), or `false` when not passed.
   */
  tts: string | boolean
}

/**
 * Parse the digest CLI arguments.
 *
 * Shared by the config loader and main so that a value belonging to a flag
 * (`--tts out.mp3`) is never mistaken for the positional config path.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const result: ParsedArgs = { scoreOnly: false, tts: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--score-only') {
      result.scoreOnly = true
    } else if (arg === '--tts') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        result.tts = next
        i++ // consume the value
      } else {
        result.tts = true
      }
    } else if (!arg.startsWith('--') && result.configPath === undefined) {
      result.configPath = arg
    } else if (VALUE_FLAGS.has(arg)) {
      i++ // skip the value of any other value-taking flag
    }
  }

  return result
}

export function loadConfig(path?: string): DigestConfig {
  const configPath = resolve(path ?? parseArgs().configPath ?? './digest.config.json')

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

  // Parse optional digestFallbackApi
  const digestFallbackApi = config.digestFallbackApi as Record<string, unknown> | undefined
  const parsedDigestFallbackApi = (digestFallbackApi?.apiBaseUrl && digestFallbackApi?.apiKey && digestFallbackApi?.model)
    ? {
        apiBaseUrl: digestFallbackApi.apiBaseUrl as string,
        apiKey: digestFallbackApi.apiKey as string,
        model: digestFallbackApi.model as string,
        temperature: (digestFallbackApi.temperature as number | undefined),
      }
    : undefined

  // Parse optional ttsApi
  const ttsApi = config.ttsApi as Record<string, unknown> | undefined
  let parsedTtsApi: TTSConfig | undefined
  if (ttsApi) {
    if (!ttsApi.apiBaseUrl || !ttsApi.apiKey || !ttsApi.model) {
      throw new Error('Config: "ttsApi" requires apiBaseUrl, apiKey, and model')
    }
    parsedTtsApi = {
      apiBaseUrl: ttsApi.apiBaseUrl as string,
      apiKey: ttsApi.apiKey as string,
      model: ttsApi.model as string,
      voice: ttsApi.voice as string | undefined,
      speed: ttsApi.speed as number | undefined,
      format: (ttsApi.format as TTSConfig['format']) ?? 'mp3',
      maxChars: ttsApi.maxChars as number | undefined,
    }
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
      concurrency: (rankingApi.concurrency as number) ?? 1,
    },
    digestApi: {
      apiBaseUrl: digestApi.apiBaseUrl as string,
      apiKey: digestApi.apiKey as string,
      model: digestApi.model as string,
      temperature: (digestApi.temperature as number) ?? 0.7,
    },
    digestFallbackApi: parsedDigestFallbackApi,
    learnerApi: parsedLearnerApi,
    userPrompt: config.userPrompt as string,
    learnFromLikes: (config.learnFromLikes as boolean) ?? true,
    likesBatchSize: (config.likesBatchSize as number) ?? 50,
    learnedPromptCache: (config.learnedPromptCache as string) ?? './digest.learned.json',
    scoreCachePath: (config.scoreCachePath as string) ?? './digest.scores.json',
    scoreCacheTTLDays: (config.scoreCacheTTLDays as number) ?? 90,
    hoursBack: (config.hoursBack as number) ?? 24,
    topN: (config.topN as number) ?? 15,
    maxPosts: (config.maxPosts as number) ?? 500,
    digestSystemPrompt: ((config.digestSystemPrompt as string) ?? DEFAULT_DIGEST_SYSTEM_PROMPT) + HUMANIZER_APPENDIX,
    digestPrompt: (config.digestPrompt as string) ?? DEFAULT_DIGEST_PROMPT,
    ttsApi: parsedTtsApi,
    ttsOutputPath: config.ttsOutputPath as string | undefined,
  }
}
