import { collectPostPubkeys, createFetcher, createRanker, refreshLearnedPrompt, scorePostsCached, sortByRelevance, rankingContext, withFeedback } from 'nalgorithm'
import type { PipelineLogger, PipelineStore, ProfileData, ScoredPost } from 'nalgorithm'
import type { Db } from './db.js'
import { loadProfilesCached } from './profile-cache.js'
import type { ServerConfig } from './config.js'
import type { UserSettings } from './settings.js'
import { randomBytes } from 'node:crypto'
import { insertIgnore } from './database.js'

export interface FeedResult {
  posts: ScoredPost[]
  profiles: Record<string, ProfileData>
  /** Posts fetched before ranking (the feed shows the top of these). */
  fetched: number
  learnedPrompt?: string
}

/** What the HTTP layer needs from a feed run. Injected so tests skip relays and models. */
export type FeedRunner = (npub: string, settings: UserSettings, store: PipelineStore, signal?: AbortSignal, fresh?: boolean) => Promise<FeedResult>
export class FeedBusy extends Error {}

/** Cap on posts fetched per run, so a huge follow list cannot run up cost. */
export const MAX_POSTS = 500
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
  db?: Db
): Promise<Map<string, ProfileData>> {
  const pubkeys = collectPostPubkeys(posts, cap)
  return db ? loadProfilesCached(db, fetcher, pubkeys) : fetcher.getProfiles(pubkeys)
}

export function createFeedRunner(config: ServerConfig, log: PipelineLogger, db?: Db): FeedRunner {
  const pending = new Map<string, Promise<FeedResult>>()
  const recent = new Map<string, { at: number; result: FeedResult }>()
  const run: FeedRunner = async (npub, settings, store, signal) => {
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

      const profiles = new Map<string, ProfileData>()
      enrichment = loadFeedProfiles(fetcher, posts, undefined, db).then((found) => {
        for (const [pk, profile] of found) profiles.set(pk, profile)
      }).catch((err) => log.warn(`profile enrichment unavailable: ${(err as Error).message}`))

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
      })

      lap('scoring')
      report(`${scored.filter((p) => p.defaultScore).length} unranked`)
      return {
        posts: sortByRelevance(scored),
        profiles: Object.fromEntries(profiles),
        fetched: posts.length,
        learnedPrompt,
      }
    } finally {
      void enrichment.finally(() => fetcher.destroy())
    }
  }
  return (npub, settings, store, signal, fresh = false) => {
    const key = `${npub}:${rankingContext({ ...settings, model: config.venice.scoringModel, scorer: 'decision' })}:${settings.hoursBack}`
    const active = pending.get(key)
    if (active) return active
    const hit = recent.get(key)
    if (!fresh && hit && Date.now() - hit.at < 120_000) return Promise.resolve(hit.result)
    const owner = randomBytes(16).toString('hex')
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
        const result = await run(npub, settings, store, signal)
        if (recent.size >= 64) recent.delete(recent.keys().next().value!)
        recent.set(key, { at: Date.now(), result })
        return result
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        if (db) await db.run('DELETE FROM pipeline_jobs WHERE npub = ? AND owner = ?', [npub, owner]).catch(() => {})
      }
    })().finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
}
