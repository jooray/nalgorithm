import { collectPostPubkeys, createFetcher, createRanker, refreshLearnedPrompt, scorePostsCached, sortByRelevance, rankingContext, withFeedback } from 'nalgorithm'
import type { PipelineLogger, PipelineStore, ProfileData, ScoredPost } from 'nalgorithm'
import type { Db } from './db.js'
import { loadProfilesCached } from './profile-cache.js'
import type { ServerConfig } from './config.js'
import type { UserSettings } from './settings.js'
import { insertIgnore } from './database.js'
import { newJobOwner } from './digest-jobs.js'
import { createScoringLine, type FeedProgress } from './scoring-line.js'

export interface FeedResult {
  posts: ScoredPost[]
  profiles: Record<string, ProfileData>
  /** Posts fetched before ranking (the feed shows the top of these). */
  fetched: number
  learnedPrompt?: string
}

/**
 * What the HTTP layer needs from a feed run. Injected so tests skip relays and models.
 * `charge` is called once the run holds the reader's pipeline claim and before anything
 * costs money; a throw stops the run. It is not called when the answer is the result of
 * a run that just finished or is still running for the same reader and settings, which
 * that run's caller already paid for.
 */
export type FeedRunner = (npub: string, settings: UserSettings, store: PipelineStore, signal?: AbortSignal, fresh?: boolean, charge?: () => Promise<void>) => Promise<FeedResult>
export class FeedBusy extends Error {}

/** Cap on posts fetched per run, so a huge follow list cannot run up cost. */
export const MAX_POSTS = 500
/** How long a finished ranking waits for relay profiles not yet in the cache. */
const PROFILE_WAIT_MS = 3_000
/**
 * Runs that score at once. Each sends one request at a time, so two of them use two of
 * the provider's three slots and leave one for digest writing and speech.
 */
const SCORING_RUNS = 2
const learning = new Map<string, Promise<unknown>>()

/** Whether background learning is running for this npub (it writes the learned row when it ends). */
export function learningInProgress(npub: string): boolean {
  return learning.has(npub)
}

/**
 * Profiles for everyone the feed shows: authors, the original authors inside
 * boosts and quotes, and people mentioned in the text. A boost's own author is
 * only the booster, so looking up `author` alone leaves boosted notes nameless.
 */
export async function loadFeedProfiles(
  fetcher: { getProfiles(pubkeys: string[]): Promise<Map<string, ProfileData>> },
  posts: Parameters<typeof collectPostPubkeys>[0],
  cap?: number,
  db?: Db,
  onCached?: (cached: Map<string, ProfileData>) => void
): Promise<Map<string, ProfileData>> {
  const pubkeys = collectPostPubkeys(posts, cap)
  return db ? loadProfilesCached(db, fetcher, pubkeys, undefined, onCached) : fetcher.getProfiles(pubkeys)
}

export type FeedRunnerWithProgress = FeedRunner & { progress: (npub: string) => FeedProgress | null }

export function createFeedRunner(config: ServerConfig, log: PipelineLogger, db?: Db): FeedRunnerWithProgress {
  const recent = new Map<string, { at: number; result: FeedResult }>()
  const line = createScoringLine(SCORING_RUNS)
  const run: FeedRunner = async (npub, settings, store, signal) => {
    const startedAt = Math.floor(Date.now() / 1000)
    line.report(npub, { state: 'fetching', startedAt })
    const fetcher = createFetcher({ relays: config.relays, signal })
    let enrichment: Promise<unknown> = Promise.resolve()
    // One line per run for the operator: phase times and counts, never content or the full key.
    const started = Date.now()
    const phases: string[] = []
    const lap = (() => { let at = started; return (label: string): void => { const now = Date.now(); phases.push(`${label} ${((now - at) / 1000).toFixed(1)}s`); at = now } })()
    const report = (detail: string): void => log.info(`feed ${npub.slice(0, 8)}: ${phases.join(', ')}; ${detail}; total ${((Date.now() - started) / 1000).toFixed(1)}s`)
    try {
      const follows = await fetcher.getFollows(npub)
      lap(`${follows.length} follows`)
      if (follows.length === 0) { report('no follows'); return { posts: [], profiles: {}, fetched: 0 } }

      const posts = await fetcher.getPosts(follows, { hoursBack: settings.hoursBack, maxPosts: MAX_POSTS })
      lap(`${posts.length} posts`)
      if (posts.length === 0) { report('no posts'); return { posts: [], profiles: {}, fetched: 0 } }

      // Cached profiles are in hand at once; the relay lookup for the rest runs alongside scoring.
      const profiles = new Map<string, ProfileData>()
      let cachedReady = (): void => {}
      const cached = new Promise<void>((resolve) => (cachedReady = resolve))
      const fill = (found: Map<string, ProfileData>): void => { for (const [pk, profile] of found) profiles.set(pk, profile) }
      enrichment = loadFeedProfiles(fetcher, posts, undefined, db, (found) => { fill(found); cachedReady() })
        .then(fill)
        .catch((err) => log.warn(`profile enrichment unavailable: ${(err as Error).message}`))
        .finally(cachedReady)
      await cached

      const learned = settings.learnFromLikes ? await store.getLearned() : null
      const learnedPrompt = learned?.prompt
      if (settings.learnFromLikes && !learning.has(npub) && (!learned || Date.now() - Date.parse(learned.updatedAt) >= 60 * 60_000)) {
        const learnerFetcher = createFetcher({ relays: config.relays })
        const work = refreshLearnedPrompt({ fetcher: learnerFetcher, store, pubkeyHex: npub, log,
          llm: { apiBaseUrl: config.venice.apiBaseUrl, apiKey: config.venice.apiKey, model: config.venice.learnerModel },
        }).catch((err) => log.warn(`learning failed: ${(err as Error).message}`)).finally(() => { learnerFetcher.destroy(); learning.delete(npub) })
        learning.set(npub, work)
      }

      const ranker = createRanker({
        apiBaseUrl: config.venice.apiBaseUrl,
        apiKey: config.venice.apiKey,
        model: config.venice.scoringModel,
        scorer: 'decision',
        requestsPerMinute: 90,
        signal,
      })
      const scored = await scorePostsCached({ ranker, store, scorer: 'decision', log }, posts, {
        context: rankingContext({ ...settings, model: config.venice.scoringModel, scorer: 'decision', apiBaseUrl: config.venice.apiBaseUrl }),
        userPrompt: settings.userPrompt,
        // Feedback is explicit, so it steers even with learning off; like learned taste it is prospective.
        learnedPrompt: withFeedback(learnedPrompt, settings.feedback ?? []),
        profiles,
        modelLabel: config.venice.scoringModel,
        beforeScoring: async (total) => {
          line.report(npub, { state: 'queued', ahead: 0, startedAt })
          const leave = await line.enter(npub, signal)
          line.report(npub, { state: 'ranking', scored: 0, total, startedAt })
          return leave
        },
        onProgress: (scored, total) => line.report(npub, { state: 'ranking', scored, total, startedAt }),
      })

      lap('scoring')
      // Cached scores can finish before the relays answer: give them a short, bounded wait.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([enrichment, new Promise((resolve) => (timer = setTimeout(resolve, PROFILE_WAIT_MS)))])
      clearTimeout(timer)
      report(`${scored.filter((p) => p.defaultScore).length} unranked, ${profiles.size} profiles`)
      return {
        posts: sortByRelevance(scored),
        profiles: Object.fromEntries(profiles),
        fetched: posts.length,
        learnedPrompt,
      }
    } finally {
      line.report(npub, null)
      void enrichment.finally(() => fetcher.destroy())
    }
  }
  /**
   * A caller's view of a shared run: it gives up at its own deadline, and the run
   * stops only when every caller has given up, so a digest that joins a web
   * request's run is not cut off at the request's shorter deadline.
   */
  const join = (shared: Shared, signal?: AbortSignal): Promise<FeedResult> => {
    if (!signal) {
      shared.unbounded = true
      return shared.work
    }
    shared.waiting++
    return new Promise<FeedResult>((resolve, reject) => {
      const giveUp = (): void => {
        if (--shared.waiting === 0 && !shared.unbounded) shared.controller.abort(signal.reason)
        reject(signal.reason)
      }
      if (signal.aborted) return giveUp()
      signal.addEventListener('abort', giveUp, { once: true })
      shared.work.then(resolve, reject).finally(() => signal.removeEventListener('abort', giveUp))
    })
  }
  interface Shared { work: Promise<FeedResult>; controller: AbortController; waiting: number; unbounded: boolean }
  const pending = new Map<string, Shared>()

  const runner: FeedRunner = (npub, settings, store, signal, fresh = false, charge) => {
    const key = `${npub}:${rankingContext({ ...settings, model: config.venice.scoringModel, scorer: 'decision' })}:${settings.hoursBack}`
    const active = pending.get(key)
    if (active) return join(active, signal)
    const hit = recent.get(key)
    if (!fresh && hit && Date.now() - hit.at < 120_000) return Promise.resolve(hit.result)
    const owner = newJobOwner()
    const controller = new AbortController()
    const work = (async () => {
      let heartbeat: ReturnType<typeof setInterval> | undefined
      if (db) {
        const now = Math.floor(Date.now() / 1000)
        const inserted = await db.run(insertIgnore(db, 'pipeline_jobs', ['npub', 'owner', 'lease_until']), [npub, owner, now + 600])
        if (!inserted.changes) {
          const claimed = await db.run('UPDATE pipeline_jobs SET owner = ?, lease_until = ? WHERE npub = ? AND lease_until < ?', [owner, now + 600, npub, now])
          if (!claimed.changes) throw new FeedBusy('A ranking for this reader is already running.')
        }
        heartbeat = setInterval(() => void db.run('UPDATE pipeline_jobs SET lease_until = ? WHERE npub = ? AND owner = ?', [Math.floor(Date.now() / 1000) + 600, npub, owner]).catch(() => {}), 30_000)
        heartbeat.unref()
      }
      try {
        // Charged only once the claim is held, so a busy answer never costs a unit.
        await charge?.()
        const result = await run(npub, settings, store, controller.signal)
        if (recent.size >= 64) recent.delete(recent.keys().next().value!)
        recent.set(key, { at: Date.now(), result })
        return result
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        if (db) await db.run('DELETE FROM pipeline_jobs WHERE npub = ? AND owner = ?', [npub, owner]).catch(() => {})
      }
    })().finally(() => pending.delete(key))
    const shared: Shared = { work, controller, waiting: 0, unbounded: false }
    pending.set(key, shared)
    return join(shared, signal)
  }
  return Object.assign(runner, { progress: (npub: string) => line.progress(npub) })
}
