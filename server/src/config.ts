/**
 * Server configuration, all from the environment so secrets never sit in the
 * repo. `loadConfig` takes the env as an argument so tests can pass their own.
 */

export interface ServerConfig {
  port: number
  host: string
  dbPath: string
  /**
   * Public base URL of the API, no trailing slash, for example
   * `https://cypherpunk.today/nalgorithm/api`. The login challenge is bound to
   * `<publicUrl>/auth/login`, so a signed login for another site is useless here.
   */
  publicUrl: string
  /** Whether to mark the session cookie Secure (default: true unless publicUrl is http). */
  secureCookie: boolean
  relays: string[]
  billing: { url: string; token: string }
  venice: {
    apiBaseUrl: string
    apiKey: string
    scoringModel: string
    digestModel: string
    humanizerModel: string
    learnerModel: string
    ttsModel: string
    ttsVoice: string
  }
}

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://nostr.cypherpunk.today']

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const need = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  const publicUrl = need('PUBLIC_URL').replace(/\/+$/, '')
  return {
    port: Number(env.PORT ?? 8350),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.NALGORITHM_DB_PATH ?? './nalgorithm-server.db',
    publicUrl,
    secureCookie: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : publicUrl.startsWith('https://'),
    relays: env.RELAYS ? env.RELAYS.split(',').map((r) => r.trim()).filter(Boolean) : DEFAULT_RELAYS,
    billing: { url: need('BILLING_API_URL').replace(/\/+$/, ''), token: need('BILLING_API_TOKEN') },
    venice: {
      apiBaseUrl: env.VENICE_API_BASE_URL ?? 'https://api.venice.ai/api/v1',
      apiKey: need('VENICE_API_KEY'),
      scoringModel: env.SCORING_MODEL ?? 'jev-latest',
      digestModel: env.DIGEST_MODEL ?? 'claude-sonnet-5-5',
      humanizerModel: env.HUMANIZER_MODEL ?? 'deepseek-v4-1-flash',
      learnerModel: env.LEARNER_MODEL ?? 'deepseek-v4-1-flash',
      ttsModel: env.TTS_MODEL ?? 'tts-kokoro',
      ttsVoice: env.TTS_VOICE ?? 'af_sky',
    },
  }
}
