import { nip19 } from 'nostr-tools'

/**
 * Server configuration, all from the environment so secrets never sit in the
 * repo. `loadConfig` takes the env as an argument so tests can pass their own.
 */

export interface ServerConfig {
  port: number
  host: string
  /** `mariadb://user:pass@host:3306/db`, or `sqlite:./file.db` (a bare path also works). */
  databaseUrl: string
  /**
   * Public base URL of the API, no trailing slash, for example
   * `https://cypherpunk.today/nalgorithm/api`. The login challenge is bound to
   * `<publicUrl>/auth/login`, so a signed login for another site is useless here.
   */
  publicUrl: string
  /** Whether to mark the session cookie Secure (default: true unless publicUrl is http). */
  secureCookie: boolean
  relays: string[]
  /**
   * The service account that sends and receives DMs. Absent when BOT_NSEC is not
   * set: the API still works, digests are just not delivered by DM.
   */
  bot?: {
    secretKeyHex: string
    /** Relays the bot listens on for incoming DMs and publishes its self-copies to. */
    relays: string[]
    blossomServers: string[]
  }
  /** Public URL of the web app, for links in DM replies. */
  webUrl: string
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

const DEFAULT_BOT_RELAYS = ['wss://nostr.cypherpunk.today', 'wss://nos.lol', 'wss://relay.damus.io']
const DEFAULT_BLOSSOM = ['https://blossom.primal.net']

const list = (v: string | undefined, fallback: string[]): string[] => {
  const items = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return items.length > 0 ? items : fallback
}

/** BOT_NSEC accepts an nsec1... string or 64 hex characters. */
export function parseSecretKey(value: string): string {
  const v = value.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  const m = /^nsec1[023456789acdefghjklmnpqrstuvwxyz]+$/.exec(v)
  if (!m) throw new Error('BOT_NSEC must be an nsec1... string or 64 hex characters')
  const data = nip19.decode(v)
  if (data.type !== 'nsec') throw new Error('BOT_NSEC is not an nsec')
  return Buffer.from(data.data).toString('hex')
}

function loadBot(env: Record<string, string | undefined>): ServerConfig['bot'] {
  if (!env.BOT_NSEC) return undefined
  return {
    secretKeyHex: parseSecretKey(env.BOT_NSEC),
    relays: list(env.DM_RELAYS, DEFAULT_BOT_RELAYS),
    blossomServers: list(env.BLOSSOM_SERVERS, DEFAULT_BLOSSOM),
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
    databaseUrl: env.DATABASE_URL ?? env.NALGORITHM_DB_PATH ?? './nalgorithm-server.db',
    publicUrl,
    secureCookie: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : publicUrl.startsWith('https://'),
    webUrl: (env.WEB_URL ?? publicUrl.replace(/\/api$/, '')).replace(/\/+$/, '') + '/',
    bot: loadBot(env),
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
      ttsVoice: env.TTS_VOICE ?? 'af_bella',
    },
  }
}
