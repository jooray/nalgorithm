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
}

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
      }
    }
    case 'active':
      return {
        kind: 'active',
        text: ent.until ? `Subscribed until ${formatDate(ent.until)}` : 'Subscribed',
        canRank: true,
        actionLabel: 'Add time',
      }
    case 'expired':
      return {
        kind: 'expired',
        text: 'Your access has ended. Subscribe to keep ranking your feed.',
        canRank: false,
        actionLabel: 'Subscribe',
      }
    case 'none':
      return {
        kind: 'none',
        text: 'Your free 3-day trial starts when you first load your feed.',
        canRank: true,
        actionLabel: null,
      }
    default:
      return {
        kind: 'unknown',
        text: 'Subscription status is unavailable right now.',
        canRank: true,
        actionLabel: null,
      }
  }
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
  if (status === 502) {
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
