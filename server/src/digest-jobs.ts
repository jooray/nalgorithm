import type { PipelineLogger } from 'nalgorithm'
import { insertIgnore } from './database.js'
import type { Db } from './db.js'
import type { JobTracker } from './drain.js'
import { randomBytes } from 'node:crypto'

/** A claim older than this is treated as dead (a crash or a stuck model call). */
export const DIGEST_JOB_STALE_SECONDS = 600

/** Thrown when a digest is already being made for this npub. */
export class DigestRunning extends Error {
  constructor(readonly startedAt: number) {
    super('a digest is already being made')
  }
}

export interface DigestJobStatus {
  running: boolean
  startedAt: number | null
  /** How long the last successful digest took, from start to delivery. Null before the first. */
  lastDurationSeconds: number | null
  /** The outcome of the last finished run (`sent`, `failed`, `no_prompt`, ...). Null before the first. */
  lastStatus: string | null
  finishedAt: number | null
}

interface JobRow {
  lease_at?: number | null
  started_at: number
  running: number
  finished_at: number | null
  last_duration: number | null
  last_status: string | null
}

export type Claim = { claimed: true; startedAt: number; owner: string } | { claimed: false; startedAt: number }

/**
 * Take the one digest slot for `npub`, atomically. The claim is a row in the
 * database, so two simultaneous requests (or two server processes) cannot both
 * win: the insert or the conditional update changes exactly one row.
 * A refused claim carries the start time of the run that holds the slot.
 */
export async function claimDigestJob(db: Db, npub: string, now: number): Promise<Claim> {
  const owner = randomBytes(16).toString('hex')
  const inserted = await db.run(insertIgnore(db, 'digest_jobs', ['npub', 'started_at', 'running', 'lease_at', 'owner']), [npub, now, 1, now, owner])
  if (inserted.changes === 1) return { claimed: true, startedAt: now, owner }
  const taken = await db.run('UPDATE digest_jobs SET running = 1, started_at = ?, lease_at = ?, owner = ?, finished_at = NULL WHERE npub = ? AND (running = 0 OR COALESCE(lease_at, started_at) <= ?)', [
    now,
    now,
    owner,
    npub,
    now - DIGEST_JOB_STALE_SECONDS,
  ])
  if (taken.changes === 1) return { claimed: true, startedAt: now, owner }
  const row = await db.get<JobRow>('SELECT started_at, running, finished_at, last_duration, last_status FROM digest_jobs WHERE npub = ?', [npub])
  return { claimed: false, startedAt: Number(row?.started_at ?? now) }
}

/** Release the slot. Only a successful run updates the duration estimate. */
export async function finishDigestJob(db: Db, npub: string, startedAt: number, status: string, now: number, owner?: string): Promise<void> {
  const owned = owner ? ' AND owner = ?' : ''
  if (status === 'sent') {
    await db.run('UPDATE digest_jobs SET running = 0, finished_at = ?, last_status = ?, last_duration = ? WHERE npub = ? AND started_at = ?' + owned, [
      now,
      status,
      Math.max(0, now - startedAt),
      npub,
      startedAt,
      ...(owner ? [owner] : []),
    ])
  } else {
    await db.run('UPDATE digest_jobs SET running = 0, finished_at = ?, last_status = ? WHERE npub = ? AND started_at = ?' + owned, [now, status, npub, startedAt, ...(owner ? [owner] : [])])
  }
}

export async function digestJobStatus(db: Db, npub: string, now: number): Promise<DigestJobStatus> {
  const row = await db.get<JobRow>('SELECT started_at, lease_at, running, finished_at, last_duration, last_status FROM digest_jobs WHERE npub = ?', [npub])
  if (!row) return { running: false, startedAt: null, lastDurationSeconds: null, lastStatus: null, finishedAt: null }
  const running = Number(row.running) === 1 && now - Number(row.lease_at ?? row.started_at) < DIGEST_JOB_STALE_SECONDS
  return {
    running,
    startedAt: running ? Number(row.started_at) : null,
    lastDurationSeconds: row.last_duration === null ? null : Number(row.last_duration),
    lastStatus: row.last_status,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  }
}

/**
 * Mark every running job as interrupted. Used at startup (a running row then
 * belongs to a process that died) and on a forced exit after the drain timed
 * out, so a dead job is never reported as still running.
 */
export async function interruptRunningJobs(db: Db, now: number): Promise<number> {
  return (await db.run("UPDATE digest_jobs SET running = 0, finished_at = ?, last_status = 'interrupted' WHERE running = 1 AND COALESCE(lease_at, started_at) <= ?", [now, now - DIGEST_JOB_STALE_SECONDS])).changes
}

function renewLease(db: Db, npub: string, owner: string, now: () => number): () => void {
  const timer = setInterval(() => void db.run('UPDATE digest_jobs SET lease_at = ? WHERE npub = ? AND owner = ? AND running = 1', [now(), npub, owner]).catch(() => {}), 30_000)
  timer.unref()
  return () => clearInterval(timer)
}

/** Run `work` inside the slot. A second caller gets `busy` instead of a second digest. */
export async function runInSlot<T extends { status: string }>(
  db: Db,
  npub: string,
  now: () => number,
  work: () => Promise<T>,
  jobs?: JobTracker,
): Promise<T | { status: 'busy'; detail: string }> {
  let end: (() => void) | undefined
  try {
    end = jobs?.begin()
  } catch {
    return { status: 'busy', detail: 'the server is restarting' }
  }
  const claim = await claimDigestJob(db, npub, now())
  if (!claim.claimed) {
    end?.()
    return { status: 'busy', detail: 'a digest is already being made' }
  }
  let status = 'failed'
  const stopLease = renewLease(db, npub, claim.owner, now)
  try {
    const outcome = await work()
    status = outcome.status
    return outcome
  } finally {
    stopLease()
    await finishDigestJob(db, npub, claim.startedAt, status, now(), claim.owner).catch(() => {})
    end?.()
  }
}

export interface DigestNowDeps {
  db: Db
  run: (npub: string, opts: { manual: true; signal?: AbortSignal }) => Promise<{ status: string; detail?: string }>
  /** Tell the person why no digest came, or send nothing. */
  onOutcome?: (npub: string, outcome: { status: string; detail?: string }) => Promise<void>
  log: PipelineLogger
  now?: () => number
  /** Counts the run so a shutdown waits for it. Begin throws `ShuttingDown` once it has started. */
  jobs?: JobTracker
}

/**
 * "Digest now": claim the slot, answer immediately, do the work in the
 * background. Throws `DigestRunning` when one is already in progress.
 */
export function createDigestNow(deps: DigestNowDeps): (npub: string) => Promise<string> {
  const now = (): number => (deps.now ? deps.now() : Math.floor(Date.now() / 1000))
  return async (npub) => {
    if (deps.jobs && deps.jobs.active >= 12) throw new Error('Digest queue is full. Try again shortly.')
    const end = deps.jobs?.begin()
    const claim = await claimDigestJob(deps.db, npub, now()).catch((err) => {
      end?.()
      throw err
    })
    if (!claim.claimed) {
      end?.()
      throw new DigestRunning(claim.startedAt)
    }
    void (async () => {
      const stopLease = renewLease(deps.db, npub, claim.owner, now)
      let outcome: { status: string; detail?: string }
      try {
        outcome = await deps.run(npub, { manual: true, signal: AbortSignal.timeout(30 * 60_000) })
      } catch (err) {
        outcome = { status: 'failed', detail: (err as Error).message }
      }
      stopLease()
      await finishDigestJob(deps.db, npub, claim.startedAt, outcome.status, now(), claim.owner).catch(() => {})
      deps.log.info(`manual digest for ${npub.slice(0, 8)}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`)
      await deps.onOutcome?.(npub, outcome).catch(() => {})
      end?.()
    })()
    return 'On its way. Making a digest takes a few minutes; it will arrive in this chat.'
  }
}
