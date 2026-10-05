/**
 * Nalgorithm Web — digest generation feedback and first-run automation (pure)
 */

export interface DigestStatus {
  running: boolean
  startedAt: number | null
  lastDurationSeconds: number | null
  lastStatus: string | null
  finishedAt: number | null
}

export const IDLE_STATUS: DigestStatus = { running: false, startedAt: null, lastDurationSeconds: null, lastStatus: null, finishedAt: null }

/** Read the server's answer defensively: anything odd means "not running". */
export function readDigestStatus(v: unknown): DigestStatus {
  if (!v || typeof v !== 'object') return IDLE_STATUS
  const o = v as Record<string, unknown>
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  return {
    running: o.running === true,
    startedAt: num(o.startedAt),
    lastDurationSeconds: num(o.lastDurationSeconds),
    lastStatus: typeof o.lastStatus === 'string' ? o.lastStatus : null,
    finishedAt: num(o.finishedAt),
  }
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "usually about 2 minutes", or "usually a few minutes" before there is a run to learn from. */
export function estimateText(lastDurationSeconds: number | null): string {
  if (lastDurationSeconds === null || lastDurationSeconds <= 0) return 'usually a few minutes'
  if (lastDurationSeconds < 90) return 'usually about a minute'
  return `usually about ${Math.round(lastDurationSeconds / 60)} minutes`
}

/** The one status line while a digest is being written. */
export function progressText(status: DigestStatus, nowSec: number): string {
  const elapsed = status.startedAt === null ? 0 : nowSec - status.startedAt
  return `Writing your digest… ${clock(elapsed)} so far, ${estimateText(status.lastDurationSeconds)}. It will appear here and arrive by DM.`
}

export interface MakeButtonView {
  label: string
  disabled: boolean
  busy: boolean
}

/** What every make button says and whether it can be pressed. */
export function makeButtonView(i: { running: boolean; hasDigests: boolean; firstLabel: string; anotherLabel: string }): MakeButtonView {
  if (i.running) return { label: 'Writing your digest…', disabled: true, busy: true }
  return { label: i.hasDigests ? i.anotherLabel : i.firstLabel, disabled: false, busy: false }
}

export const ANOTHER_DIGEST_HINT = 'Writes a new one from your latest notes.'

export type JobStep =
  /** Nothing changed that the reader needs to hear about. */
  | { kind: 'none' }
  /** A run was in progress and ended with a digest: fetch the list and show it. `dmPending`: its DM did not go through yet. */
  | { kind: 'arrived'; dmPending: boolean }
  /** A run was in progress and ended without a digest. */
  | { kind: 'failed'; message: string; action: 'retry' | 'pay' | 'settings' }

/** What to say when a digest run ended without a digest. */
export function failureFor(lastStatus: string | null): { message: string; action: 'retry' | 'pay' | 'settings' } {
  switch (lastStatus) {
    case 'no_prompt':
      return { message: 'Your digest needs a prompt first. Write what you care about in Tune.', action: 'settings' }
    case 'not_entitled':
      return { message: 'Your free trial or subscription has ended, so no digest was written.', action: 'pay' }
    case 'capped':
      return { message: 'You have reached the daily limit for digests. Try again tomorrow.', action: 'retry' }
    case 'no_posts':
      return { message: 'Nothing new from the people you follow in your time window, so no digest was written. Try a longer window in Tune.', action: 'settings' }
    case 'billing_unavailable':
      return { message: 'Billing is unreachable right now, so the digest could not start. Try again in a few minutes.', action: 'retry' }
    case 'interrupted':
      return { message: 'The digest was interrupted by a server restart. Press the button to start it again.', action: 'retry' }
    default:
      return { message: 'The digest could not be written. Try again in a few minutes.', action: 'retry' }
  }
}

/** Compare the previous and the newest status. Only a running-to-finished change is news. */
export function nextJobStep(wasRunning: boolean, now: DigestStatus): JobStep {
  if (!wasRunning || now.running) return { kind: 'none' }
  if (now.lastStatus === 'sent') return { kind: 'arrived', dmPending: false }
  if (now.lastStatus === 'delivery_pending') return { kind: 'arrived', dmPending: true }
  return { kind: 'failed', ...failureFor(now.lastStatus) }
}

// ─── first run ───────────────────────────────────────────────────────────────

export const FIRST_DIGEST_KEY_PREFIX = 'nalgorithm_first_digest_'

export const firstDigestKey = (npub: string): string => `${FIRST_DIGEST_KEY_PREFIX}${npub}`

/** Whether the first digest should be requested now. Asked at most once per npub, ever. */
export function shouldRequestFirstDigest(i: {
  hasPrompt: boolean
  postCount: number
  digestCount: number
  digestsKnown: boolean
  jobRunning: boolean
  alreadyRequested: boolean
  paywalled: boolean
}): boolean {
  return (
    i.hasPrompt &&
    i.postCount > 0 &&
    i.digestsKnown &&
    i.digestCount === 0 &&
    !i.jobRunning &&
    !i.alreadyRequested &&
    !i.paywalled
  )
}

/**
 * The newest digest the reader did not have before asking. Works from an empty
 * list: nothing known means everything is new, so the first digest is found too.
 */
export function findArrived<T extends { id: string }>(knownIds: Iterable<string>, list: readonly T[]): T | null {
  const known = new Set(knownIds)
  return list.find((d) => !known.has(d.id)) ?? null
}

/**
 * The digest row is saved before its DM goes out, so the list can show the new digest
 * while the job still says "running". The reader can play it already; whether the DM
 * was accepted is only known when the job finishes.
 */
export function readyDuringRun(status: DigestStatus, list: readonly { createdAt: number }[]): boolean {
  return status.running && status.startedAt !== null && list.some((d) => d.createdAt >= (status.startedAt as number))
}

/** What to say once the digest is in the list. */
export function arrivalText(stage: 'ready' | 'sent' | 'dm_pending'): string {
  if (stage === 'ready') return 'Your digest is ready here. Sending it to your DMs…'
  if (stage === 'dm_pending') return 'Your digest is ready here. Its DM has not gone through yet; the server will try again.'
  return 'Your digest has arrived.'
}
