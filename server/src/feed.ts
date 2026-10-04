import { collectPostPubkeys, createFetcher, createRanker, refreshLearnedPrompt, scorePostsCached, sortByRelevance, rankingContext } from 'nalgorithm'
import type { PipelineLogger, PipelineStore, ProfileData, ScoredPost } from 'nalgorithm'
import type { Db } from './db.js'
import { loadProfilesCached } from './profile-cache.js'
import type { ServerConfig } from './config.js'
import type { UserSettings } from './settings.js'

export interface FeedResult {
  posts: ScoredPost[]
  profiles: Record<string, ProfileData>
  /** Posts fetched before ranking (the feed shows the top of these). */
  fetched: number
  learnedPrompt?: string
}

/** What the HTTP layer needs from a feed run. Injected so tests skip relays and models. */
export type FeedRunner = (npub: string, settings: UserSettings, store: PipelineStore) => Promise<FeedResult>

/** Cap on posts fetched per run, so a huge follow list cannot run up cost. */
export const MAX_POSTS = 500

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
  return async (npub, settings, store) => {
    const fetcher = createFetcher({ relays: config.relays })
    try {
      const follows = await fetcher.getFollows(npub)
      if (follows.length === 0) return { posts: [], profiles: {}, fetched: 0 }

      const posts = await fetcher.getPosts(follows, { hoursBack: settings.hoursBack, maxPosts: MAX_POSTS })
      if (posts.length === 0) return { posts: [], profiles: {}, fetched: 0 }

      const profiles = await loadFeedProfiles(fetcher, posts, undefined, db)

      let learnedPrompt: string | undefined
      if (settings.learnFromLikes) {
        learnedPrompt = await refreshLearnedPrompt({
          fetcher,
          store,
          pubkeyHex: npub,
          log,
          llm: {
            apiBaseUrl: config.venice.apiBaseUrl,
            apiKey: config.venice.apiKey,
            model: config.venice.learnerModel,
          },
        })
      } else {
        learnedPrompt = undefined
      }

      const ranker = createRanker({
        apiBaseUrl: config.venice.apiBaseUrl,
        apiKey: config.venice.apiKey,
        model: config.venice.scoringModel,
        scorer: 'decision',
        requestsPerMinute: 90,
      })
      const scored = await scorePostsCached({ ranker, store, scorer: 'decision', log }, posts, {
        context: rankingContext({ ...settings, model: config.venice.scoringModel, scorer: 'decision', apiBaseUrl: config.venice.apiBaseUrl }),
        userPrompt: settings.userPrompt,
        learnedPrompt,
        profiles,
        modelLabel: config.venice.scoringModel,
      })

      return {
        posts: sortByRelevance(scored),
        profiles: Object.fromEntries(profiles),
        fetched: posts.length,
        learnedPrompt,
      }
    } finally {
      fetcher.destroy()
    }
  }
}
