/**
 * Nalgorithm Web — hosted mode, pure logic
 *
 * Everything here is free of DOM, network and storage access, so the rules
 * (prices, limits, which message to show for which server error) can be unit
 * tested on their own. Imports nothing, on purpose.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type EntitlementState = 'active' | 'trial' | 'expired' | 'none' | 'unknown'

export interface Entitlement {
  state: EntitlementState
  /** Unix seconds. End of the trial or of the paid period. */
  until?: number
}

export type PlanId = 'nalgorithm' | 'all-access'

export type AppMode = 'hosted' | 'byok'

/** What the user should be able to do about an error. */
export type ErrorAction = 'login' | 'settings' | 'pay' | 'retry'

export interface DescribedError {
  message: string
  action: ErrorAction
}

// ─── Limits and prices (mirror the server) ───────────────────────────────────

export const MAX_PROMPT_CHARS = 2000
export const HOURS_BACK_RANGE = { min: 1, max: 72 } as const
export const TOP_N_RANGE = { min: 1, max: 30 } as const
export const MIN_SATS = 1000

export const PLANS: Record<PlanId, { label: string; sats: number; days: number; blurb: string }> = {
  nalgorithm: {
    label: 'Nalgorithm',
    sats: 10_000,
    days: 30,
    blurb: '10,000 sats for 30 days',
  },
  'all-access': {
    label: 'All-access',
    sats: 25_000,
    days: 30,
    blurb: '25,000 sats for 30 days, also unlocks two sibling apps',
  },
}

const DAY_SECONDS = 86_400

// ─── Mode ────────────────────────────────────────────────────────────────────

/**
 * Which mode to start in. A stored choice always wins. Someone who already set
 * up their own key before hosted mode existed keeps BYOK without being asked;
 * everyone else gets the choice screen.
 */
export function chooseMode(stored: string | null | undefined, hasByokSettings: boolean): AppMode | 'choose' {
  if (stored === 'hosted' || stored === 'byok') return stored
  return hasByokSettings ? 'byok' : 'choose'
}

// ─── Login ───────────────────────────────────────────────────────────────────

/** The unsigned login event: bound to the challenge URL, method and nonce. */
export function buildLoginTemplate(url: string, nonce: string, now: number) {
  return {
    kind: 27235,
    created_at: now,
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['nonce', nonce],
    ],
    content: '',
  }
}

/** Only ever navigate to http(s) URLs the server hands back. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Whole non-negative number from a text field, or NaN. `1e3` and `2.5` are not accepted. */
export function parseWholeNumber(text: string): number {
  const t = text.trim()
  return /^\d+$/.test(t) ? Number(t) : NaN
}

export interface HostedSettings {
  userPrompt: string
  hoursBack: number
  topN: number
  learnFromLikes: boolean
  /** Link cards under posts; the server fetches the pages. Absent from older servers, meaning on. */
  linkPreviews?: boolean
  /** Target spoken digest length in minutes (3, 6 or 10). Absent from older servers, meaning 6. */
  digestMinutes?: number
  /** Private more/less rules that steer ranking. Absent from older servers. */
  feedback?: Array<{ kind: 'more' | 'less'; excerpt: string }>
}

/** The first problem with the settings, or null. Same limits the server enforces. */
export function validateHostedSettings(s: {
  userPrompt: string
  hoursBack: number
  topN: number
}): string | null {
  if (s.userPrompt.length > MAX_PROMPT_CHARS) {
    return `The prompt is limited to ${MAX_PROMPT_CHARS} characters (now ${s.userPrompt.length}).`
  }
  if (!Number.isInteger(s.hoursBack) || s.hoursBack < HOURS_BACK_RANGE.min || s.hoursBack > HOURS_BACK_RANGE.max) {
    return `Time window must be a whole number of hours from ${HOURS_BACK_RANGE.min} to ${HOURS_BACK_RANGE.max}.`
  }
  if (!Number.isInteger(s.topN) || s.topN < TOP_N_RANGE.min || s.topN > TOP_N_RANGE.max) {
    return `Posts to show must be a whole number from ${TOP_N_RANGE.min} to ${TOP_N_RANGE.max}.`
  }
  return null
}

// ─── Payment ─────────────────────────────────────────────────────────────────

/** Days a payment buys, pro rata, rounded down to a tenth of a day. */
export function daysForSats(plan: PlanId, sats: number): number {
  const p = PLANS[plan]
  if (!Number.isFinite(sats) || sats <= 0) return 0
  return Math.floor((sats / p.sats) * p.days * 10 + 1e-9) / 10
}

/** "30 days", "1 day", "7.5 days". */
export function formatDays(days: number): string {
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1)
  return `${text} ${days === 1 ? 'day' : 'days'}`
}

/** Sats formatted with thousands separators, for display. */
export function formatSats(sats: number): string {
  return `${Math.trunc(sats).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sats`
}

/** The first problem with a custom amount, or null. */
export function validateSats(sats: number): string | null {
  if (!Number.isInteger(sats)) return 'Enter a whole number of sats.'
  if (sats < MIN_SATS) return `The minimum is ${formatSats(MIN_SATS)}.`
  return null
}

/**
 * Has a payment landed? Active where it was not before, or active with a later
 * end date than before (a top-up while already subscribed).
 */
export function paymentConfirmed(before: Entitlement | null, now: Entitlement): boolean {
  if (now.state !== 'active') return false
  if (!before || before.state !== 'active') return true
  return (now.until ?? 0) > (before.until ?? 0)
}

// ─── Entitlement → UI ────────────────────────────────────────────────────────

export interface EntitlementView {
  kind: EntitlementState
  /** Banner text. */
  text: string
  /** Whether asking for a feed can work. `none` can: the first feed starts the trial. */
  canRank: boolean
  /** Label for the banner button, or null for none. */
  actionLabel: string | null
  /** Whether the banner above the feed shows. Tune always shows the status. */
  banner: boolean
}

/** A subscription further out than this keeps the banner above the feed hidden. */
export const BANNER_BEFORE_EXPIRY_SECONDS = 90 * DAY_SECONDS

/** Whole days left, counting a started day as a day. Never negative. */
export function daysLeft(until: number | undefined, now: number): number {
  if (until === undefined) return 0
  return Math.max(0, Math.ceil((until - now) / DAY_SECONDS))
}

/** Default date formatter: the viewer's own locale. Injectable so tests are stable. */
function localDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function entitlementView(
  ent: Entitlement,
  now: number,
  formatDate: (sec: number) => string = localDate
): EntitlementView {
  switch (ent.state) {
    case 'trial': {
      const n = daysLeft(ent.until, now)
      return {
        kind: 'trial',
        text: `Free trial: ${n} ${n === 1 ? 'day' : 'days'} left`,
        canRank: true,
        actionLabel: 'Subscribe',
        banner: true,
      }
    }
    case 'active':
      return {
        kind: 'active',
        text: ent.until ? `Subscribed until ${formatDate(ent.until)}` : 'Subscribed',
        canRank: true,
        actionLabel: 'Add time',
        banner: ent.until === undefined || ent.until - now < BANNER_BEFORE_EXPIRY_SECONDS,
      }
    case 'expired':
      return {
        kind: 'expired',
        text: 'Your access has ended. Subscribe to keep ranking your feed.',
        canRank: false,
        actionLabel: 'Subscribe',
        banner: true,
      }
    case 'none':
      return {
        kind: 'none',
        text: 'Your free 3-day trial starts when you first load your feed.',
        canRank: true,
        actionLabel: null,
        banner: true,
      }
    default:
      return {
        kind: 'unknown',
        text: 'Subscription status is unavailable right now.',
        canRank: true,
        actionLabel: null,
        banner: true,
      }
  }
}

// ─── Feed run progress ───────────────────────────────────────────────────────

/** What the server says the reader's feed run is doing (GET /feed/progress). */
export type FeedProgress =
  | { state: 'idle' }
  | { state: 'fetching'; startedAt: number }
  | { state: 'queued'; ahead: number; startedAt: number }
  | { state: 'ranking'; scored: number; total: number; startedAt: number }

export function readFeedProgress(raw: unknown): FeedProgress {
  const r = (raw ?? {}) as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)
  if (r.state === 'fetching') return { state: 'fetching', startedAt: n(r.startedAt) }
  if (r.state === 'queued') return { state: 'queued', ahead: n(r.ahead), startedAt: n(r.startedAt) }
  if (r.state === 'ranking') return { state: 'ranking', scored: n(r.scored), total: n(r.total), startedAt: n(r.startedAt) }
  return { state: 'idle' }
}

/** One line for the reader: where their run is, so a wait reads as a line, not a hang. */
export function describeProgress(p: FeedProgress | null, seconds: number): string {
  const so = `${seconds}s so far`
  if (!p || p.state === 'idle') return `Ranking your feed. This can take up to a minute (${so}).`
  if (p.state === 'fetching') return `Fetching notes from the people you follow (${so}).`
  if (p.state === 'queued') {
    const line = p.ahead === 0 ? 'You are next in line' : `Waiting in line: ${p.ahead} ${p.ahead === 1 ? 'ranking' : 'rankings'} ahead of yours`
    return `${line}. Others are being ranked right now (${so}).`
  }
  if (p.total === 0) return `Ranking your feed (${so}).`
  return `Ranking ${p.scored} of ${p.total} new notes (${so}).`
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Turn an API failure into something to say to a person, plus what they can do. */
export function describeError(e: { status: number; code?: string; message?: string }): DescribedError {
  const { status, code } = e
  if (status === 401) {
    return { message: 'Your session has ended. Sign in again to continue.', action: 'login' }
  }
  if (status === 400 && code === 'no_prompt') {
    return {
      message: 'Tell Nalgorithm what you care about first: add a prompt in Settings.',
      action: 'settings',
    }
  }
  if (status === 400) {
    return { message: e.message ? `That was not accepted: ${e.message}` : 'That was not accepted.', action: 'settings' }
  }
  if (status === 402) {
    return {
      message: 'Your free trial or subscription has ended. Choose a plan to keep going.',
      action: 'pay',
    }
  }
  if (status === 429 && code === 'in_progress') {
    return {
      message: 'A feed run is already in progress. Wait for it to finish, then refresh.',
      action: 'retry',
    }
  }
  if (status === 429 && code === 'daily_cap') {
    return { message: 'You have reached the daily limit for feed runs. Try again tomorrow.', action: 'retry' }
  }
  if (status === 429) {
    return { message: 'Too many requests. Wait a moment and try again.', action: 'retry' }
  }
  if (status === 503 && code === 'billing_unavailable') {
    return {
      message: 'Billing is temporarily unavailable, so the feed cannot be loaded. Try again in a minute.',
      action: 'retry',
    }
  }
  if (status === 503 && code === 'busy') {
    return { message: 'Ranking is busy right now. Your last ranking stays; try again in a minute.', action: 'retry' }
  }
  // Only the checkout answers 502 itself; a proxy's 502 during a restart is not about payments.
  if (status === 502 && /payment/i.test(e.message ?? '')) {
    return { message: 'Payments are unavailable right now. Try again shortly.', action: 'retry' }
  }
  if (status === 0) {
    return { message: 'Could not reach the server. Check your connection and try again.', action: 'retry' }
  }
  if (status >= 500) {
    return { message: 'The server had a problem. Try again shortly.', action: 'retry' }
  }
  return { message: e.message || 'Something went wrong.', action: 'retry' }
}

// ─── Daily digest ────────────────────────────────────────────────────────────

export type DmFormat = 'nip17' | 'nip04'

export interface Schedule {
  enabled: boolean
  /** 24-hour "HH:MM" in `tz`. */
  time: string
  tz: string
  voice: string | null
  dmFormat: DmFormat | null
  /** Unix seconds. */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
}

export interface Digest {
  id: number
  /** Unix seconds. */
  createdAt: number
  text: string
  audioUrl: string | null
}

/** The service's public Nostr account, which sends the digests. */
export const DIGEST_BOT_NPUB = 'npub1dka50zsfvru0tsv2sqd40ktnwyd3236c3hzx62hhlxw9un408tcqz6wkt0'

export const DIGEST_LIST_LIMIT = 5

const VOICE_GROUPS: Array<[string, string, string[]]> = [
  ['US, female', 'af_', ['bella', 'heart', 'nicole', 'sarah', 'sky', 'jessica', 'nova', 'river', 'kore', 'aoede', 'alloy', 'jadzia']],
  ['UK, female', 'bf_', ['emma', 'alice', 'lily']],
  ['US, male', 'am_', ['adam', 'michael', 'eric', 'liam', 'onyx']],
  ['UK, male', 'bm_', ['george', 'daniel', 'lewis', 'fable']],
]

/** Kokoro voices the server accepts, with a label for the select. */
export const DIGEST_VOICES: ReadonlyArray<{ id: string; label: string }> = VOICE_GROUPS.flatMap(
  ([kind, prefix, names]) =>
    names.map((n) => ({ id: prefix + n, label: `${n[0].toUpperCase()}${n.slice(1)} (${kind})` }))
)

/** Voices with a listenable sample on the server (its SAMPLE_VOICES), offered first. */
export const SAMPLE_VOICE_IDS: readonly string[] = ['af_bella', 'af_heart', 'af_sky', 'bf_emma', 'am_michael', 'bm_george']

/**
 * The delivery format, asked as "which app reads your DMs". The server's automatic choice
 * is the format of the reader's last message to the digest account, else legacy, which
 * nearly every client can read.
 */
export const DM_FORMATS: ReadonlyArray<{ value: DmFormat | ''; label: string }> = [
  { value: '', label: 'Not sure: pick automatically' },
  { value: 'nip04', label: 'Primal, Damus or another app with older DMs' },
  { value: 'nip17', label: 'Amethyst, 0xchat, Coracle, Nostur or another app with private DMs' },
]

export const DM_FORMAT_HINT =
  'Automatic uses the format of your last message to the digest account, otherwise the older format that almost every app can read. Both are encrypted, but the older format shows relays that the digest account writes to you; private DMs (NIP-17) hide that, and some apps cannot show them.'

/** One line for the Digests tab: is daily delivery on, and when is the next one. */
export function scheduleLine(s: Pick<Schedule, 'enabled' | 'nextRunAt' | 'tz'> | null): string {
  if (!s) return ''
  if (!s.enabled) return 'Daily delivery is off. Digests come only when you ask.'
  if (s.nextRunAt === null || !isValidTimeZone(s.tz)) return 'Daily delivery is on.'
  return `Daily delivery is on. Next: ${formatInZone(s.nextRunAt, s.tz)} (${s.tz}).`
}

/** Whether the browser knows this IANA time zone. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

/** "07:30" style 24-hour time, or false. */
export function isValidTime(time: unknown): time is string {
  return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

export function isKnownVoice(voice: unknown): boolean {
  return typeof voice === 'string' && DIGEST_VOICES.some((v) => v.id === voice)
}

/** The first problem with the schedule form, or null. */
export function validateScheduleForm(f: { time: string; tz: string; voice: string | null }): string | null {
  if (!isValidTime(f.time)) return 'Pick a time of day.'
  if (!isValidTimeZone(f.tz)) return 'That time zone is not recognised. Use a name such as Europe/Bratislava.'
  if (f.voice !== null && !isKnownVoice(f.voice)) return 'Pick a voice from the list.'
  return null
}

/**
 * A schedule that was never saved comes back as UTC and off; suggest the
 * browser's zone then, so the person does not have to look it up.
 */
export function defaultTimeZone(s: Pick<Schedule, 'tz' | 'enabled'>, browserTz: string | undefined): string {
  if (s.tz === 'UTC' && !s.enabled && isValidTimeZone(browserTz)) return browserTz
  return s.tz
}

/** "Thu 1 Oct, 07:30" in the given zone (English, so the text is the same everywhere). */
export function formatInZone(sec: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(sec * 1000))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}, ${get('hour')}:${get('minute')}`
}

/** "Next digest: Thu 1 Oct, 07:30", or a line saying nothing is planned. */
export function nextRunText(s: Pick<Schedule, 'enabled' | 'nextRunAt' | 'tz'>): string {
  if (!s.enabled) return 'The daily digest is off.'
  if (s.nextRunAt === null || !isValidTimeZone(s.tz)) return ''
  return `Next digest: ${formatInZone(s.nextRunAt, s.tz)}`
}

/** The last run in plain words, or '' when nothing is known. */
export function lastStatusText(status: string | null | undefined): string {
  switch (status) {
    case 'sent':
      return 'Last digest: sent.'
    case 'delivery_pending':
      return 'Last digest: ready in the app, but its DM has not gone through yet. It will try again.'
    case 'no_prompt':
      return 'Last digest: not made, because you have not written a prompt yet. Add one in the Prompt section.'
    case 'not_entitled':
      return 'Last digest: not made, because your subscription has ended.'
    case 'billing_unavailable':
      return 'Last digest: not made, because billing could not be checked. It will try again.'
    case 'capped':
      return 'Last digest: not made, because you reached the daily limit.'
    case 'no_posts':
      return 'Last digest: nothing new to report.'
    case 'failed':
      return 'Last digest: failed. It will retry.'
    default:
      return ''
  }
}

/** What to say after asking for a digest right now. */
export function describeDigestNowError(e: { status: number; code?: string; message?: string }): DescribedError {
  if (e.status === 503 && e.code === 'digests_unavailable') {
    return { message: 'Digest delivery is not switched on for this server yet.', action: 'retry' }
  }
  if (e.status === 429 && e.code === 'daily_cap') {
    return { message: 'You have reached the daily limit for digests. Try again tomorrow.', action: 'retry' }
  }
  return describeError(e)
}

export const DIGEST_ON_ITS_WAY = 'On its way. It usually arrives in a few minutes by DM.'

export const DIGEST_DM_NOTE =
  'Digests arrive as Nostr direct messages from the service account, so your Nostr client must be able to receive DMs.'

/** Audio only ever plays from an http(s) address; anything else is dropped. */
export function safeAudioUrl(value: unknown): string | null {
  return isHttpUrl(value) ? value : null
}

/** Digest date for the list, in the viewer's own locale and zone. */
export function formatDigestDate(sec: number, tz?: string): string {
  try {
    return new Date(sec * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz && isValidTimeZone(tz) ? tz : undefined,
    })
  } catch {
    return ''
  }
}
