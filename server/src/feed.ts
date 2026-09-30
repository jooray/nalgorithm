import { createFetcher, createRanker, refreshLearnedPrompt, scorePostsCached, sortByRelevance } from 'nalgorithm'
import type { PipelineLogger, PipelineStore, ProfileData, ScoredPost } from 'nalgorithm'
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

export function createFeedRunner(config: ServerConfig, log: PipelineLogger): FeedRunner {
  return async (npub, settings, store) => {
    const fetcher = createFetcher({ relays: config.relays })
    try {
      const follows = await fetcher.getFollows(npub)
      if (follows.length === 0) return { posts: [], profiles: {}, fetched: 0 }

      const posts = await fetcher.getPosts(follows, { hoursBack: settings.hoursBack, maxPosts: MAX_POSTS })
      if (posts.length === 0) return { posts: [], profiles: {}, fetched: 0 }

      const profiles = await fetcher.getProfiles([...new Set(posts.map((p) => p.author))])

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
        learnedPrompt = (await store.getLearned())?.prompt
      }

      const ranker = createRanker({
        apiBaseUrl: config.venice.apiBaseUrl,
        apiKey: config.venice.apiKey,
        model: config.venice.scoringModel,
        scorer: 'decision',
        requestsPerMinute: 90,
      })
      const scored = await scorePostsCached({ ranker, store, scorer: 'decision', log }, posts, {
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
