import type { PipelineLogger } from 'nalgorithm'
import type { Db } from './db.js'
import { mapConcurrent } from 'nalgorithm'
import { recordRun, effectiveFormat } from './digest-job.js'
import type { DigestOutcome, DmSender } from './digest-job.js'
import { dueSchedules, loadSchedule, saveSchedule } from './schedule.js'

export interface SchedulerDeps {
  db: Db
  run: (npub: string, opts?: { manual?: boolean }) => Promise<DigestOutcome>
  dm: DmSender
  log: PipelineLogger
  now?: () => number
  /** How many digests may run at once (default 2): each one is a few model calls. */
  concurrency?: number
  /** Milliseconds between polls (default 60 s). */
  intervalMs?: number
}

/** What to tell a user when a digest could not be made. Null means stay quiet. */
export function explain(status: DigestOutcome['status'], manual: boolean): string | null {
  switch (status) {
    case 'no_prompt': return 'I have no prompt for you yet, so I cannot rank your feed. Send "prompt: what you want to see" and I will send your digest.'
    case 'not_entitled': return 'Your nalgorithm subscription has ended, so no digest today. Send "pay" for a payment link (10,000 sats for 30 days; partial amounts work).'
    case 'capped': return 'You have reached the daily limit for digests. Try again tomorrow.'
    case 'no_posts': return manual ? 'Nothing new from the people you follow in that time window.' : null
    case 'billing_unavailable': return manual ? 'I cannot check your subscription right now. Please try again in a few minutes.' : null
    case 'failed': return manual ? 'Something went wrong making your digest. Please try again in a few minutes.' : null
    default: return null
  }
}

const WEEK = 7 * 86_400

/**
 * Polls for due schedules and runs their digests.
 *
 * `tick` is exposed so tests (and a manual trigger) can drive it without timers.
 * A user is never run twice at once, and nagging is bounded: the "subscription
 * ended" and "no prompt" notices are sent once, not every day.
 */
export function createScheduler(deps: SchedulerDeps) {
  const { db, log } = deps
  const now = (): number => (deps.now ? deps.now() : Math.floor(Date.now() / 1000))
  const running = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false

  async function notify(npub: string, text: string): Promise<void> {
    try {
      await deps.dm.send(npub, text, { format: await effectiveFormat(db, npub) })
    } catch (err) {
      log.warn(`could not notify ${npub.slice(0, 8)}: ${(err as Error).message}`)
    }
  }

  async function runOne(npub: string): Promise<void> {
    if (running.has(npub)) return
    running.add(npub)
    try {
      const before = await loadSchedule(db, npub)
      let outcome: DigestOutcome
      try {
        outcome = await deps.run(npub)
      } catch (err) {
        log.warn(`digest crashed for ${npub.slice(0, 8)}: ${(err as Error).message}`)
        outcome = { status: 'failed', detail: (err as Error).message }
      }
      // The reader deleted their data while this ran: saving the schedule would bring it back.
      if (!(await db.get('SELECT npub FROM schedules WHERE npub = ?', [npub]))) {
        log.info(`digest for ${npub.slice(0, 8)}: ${outcome.status}; account deleted meanwhile`)
        return
      }
      const after = await recordRun(db, npub, outcome, now())
      const message = explain(outcome.status, false)
      const repeat = before.lastStatus === outcome.status
      // Once per condition: do not repeat a notice for the same ongoing state.
      const recentNotice = outcome.status === 'not_entitled' && before.expiredNoticeAt !== null && now() - before.expiredNoticeAt < WEEK
      if (message && !repeat && !recentNotice) {
        await notify(npub, message)
        if (outcome.status === 'not_entitled') await saveSchedule(db, { ...after, expiredNoticeAt: now() })
      }
      log.info(`digest for ${npub.slice(0, 8)}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`)
    } finally {
      running.delete(npub)
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const due = (await dueSchedules(db, now())).filter((s) => !running.has(s.npub))
      const limit = deps.concurrency ?? 2
      await mapConcurrent(due, limit, (s) => runOne(s.npub))
    } catch (err) {
      log.warn(`scheduler tick failed: ${(err as Error).message}`)
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    isRunning: (npub: string): boolean => running.has(npub),
    start(): void {
      if (timer) return
      timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000)
      timer.unref()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
