/**
 * Nalgorithm Digest — Main CLI script
 *
 * Fetches posts from a user's follows, ranks them by relevance,
 * then generates a spoken-word radio-show-style digest using an LLM.
 *
 * Usage:
 *   node dist/main.js [path/to/config.json]
 *
 * Output goes to stdout so you can pipe it wherever you like.
 */

import {
  createFetcher,
  createRanker,
  chatCompletion,
  chatCompletionWithRetry,
  pubkeyToHex,
  sortByRelevance,
} from 'nalgorithm'
import type {
  FetchedPost,
  ScoredPost,
  ProfileData,
  DebugEntry,
  LLMConfig,
} from 'nalgorithm'

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from './config.js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface LearnedPromptFile {
  prompt: string
  updatedAt: string
  /** Unix timestamp (seconds) of the most recent like that was processed */
  lastLikeTimestamp?: number
}

interface ScoreCacheFile {
  /** ISO date string of when this cache was last written */
  updatedAt: string
  /** Map of event ID → cached score data */
  scores: Record<string, {
    score: number
    justification?: string
    /** Unix timestamp (seconds) of the post */
    createdAt: number
  }>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[digest] ${msg}\n`)
}

function resolveAuthorName(
  pubkey: string,
  profiles: Map<string, ProfileData>
): string {
  const profile = profiles.get(pubkey)
  if (profile?.name) return profile.name
  return pubkey.slice(0, 8) + '...'
}

/**
 * Format a scored post for inclusion in the digest generation prompt.
 */
function formatPostForDigest(
  post: ScoredPost,
  index: number,
  profiles: Map<string, ProfileData>
): string {
  const authorName = resolveAuthorName(post.author, profiles)
  const score = post.score
  const justification = post.justification ?? ''
  const time = new Date(post.createdAt * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  let content: string
  if (post.type === 'boost' && post.originalPost) {
    const origAuthor = resolveAuthorName(post.originalPost.author, profiles)
    content = `[Boosted by ${authorName}] Originally by ${origAuthor}: ${post.originalPost.content}`
  } else if (post.type === 'quote' && post.quotedPost) {
    const quotedAuthor = resolveAuthorName(post.quotedPost.author, profiles)
    content = `${authorName} quoted ${quotedAuthor}: "${post.content}" — Original: "${post.quotedPost.content}"`
  } else {
    content = `${authorName}: ${post.content}`
  }

  // Truncate very long posts
  if (content.length > 800) {
    content = content.slice(0, 800) + '...'
  }

  return `${index + 1}. [Score: ${score}/10, ${time}] ${content}${justification ? `\n   Relevance: ${justification}` : ''}`
}

// ─── Learned prompt cache ────────────────────────────────────────────────────

function loadLearnedPrompt(cachePath: string): LearnedPromptFile | null {
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as LearnedPromptFile
    if (data.prompt) return data
  } catch {
    // No file or invalid JSON
  }
  return null
}

function saveLearnedPrompt(cachePath: string, data: LearnedPromptFile): void {
  try {
    writeFileSync(cachePath, JSON.stringify(data, null, 2))
    log(`Saved learned prompt to ${cachePath}`)
  } catch (err) {
    log(`Warning: could not save learned prompt: ${(err as Error).message}`)
  }
}

/**
 * Evolve the learned prompt by incorporating new likes.
 * If there's an existing prompt, asks the LLM to refine it with new signal.
 * If there's no existing prompt, generates one from scratch.
 */
async function evolveLearnedPrompt(
  existingPrompt: string | undefined,
  newLikes: Array<{ content: string }>,
  llmConfig: LLMConfig
): Promise<string> {
  const likesList = newLikes
    .map((l, i) => `${i + 1}. "${l.content.replace(/\n+/g, ' ').trim().slice(0, 300)}"`)
    .join('\n')

  if (existingPrompt) {
    // Evolve: refine existing prompt with new signal
    const response = await chatCompletionWithRetry(llmConfig, [
      {
        role: 'system',
        content: 'You refine user preference summaries based on new engagement data. Be concise and specific. Output only the updated summary text, no JSON, no markdown.',
      },
      {
        role: 'user',
        content: `Here is the current summary of a user's preferences based on their past Nostr likes:

${existingPrompt}

The user has recently liked these additional posts:

${likesList}

Update the preference summary to incorporate any new patterns or interests from these recent likes. Keep what's still relevant, adjust emphasis if needed, add new themes if they appear. Stay concise (2-5 sentences). If the new likes are consistent with the existing summary, only make minor refinements.

Updated summary:`,
      },
    ])
    return response.trim()
  } else {
    // Fresh: no existing prompt, generate from scratch
    // We call chatCompletionWithRetry directly instead of createLearner.summarizeLikes
    // because the learner swallows errors and returns '' — we want errors to propagate
    // so the caller can log them properly.
    const response = await chatCompletionWithRetry(llmConfig, [
      {
        role: 'system',
        content:
          'You are an analyst that summarizes user preferences based on their social media engagement. Be concise and specific. Output only the summary text, no JSON, no markdown formatting.',
      },
      {
        role: 'user',
        content: `Analyze these Nostr posts that a user has liked/reacted positively to. Based on these posts, summarize the user's interests, preferences, and the types of content they engage with.

Be specific about:
- Topics they care about
- Tone and style they prefer (philosophical, technical, casual, etc.)
- Types of content (longform, short thoughts, links, media, etc.)
- Any recurring themes

Write 2-4 concise sentences. Do not list the posts back. Just describe the user's taste.

Liked posts:
${likesList}

Summary:`,
      },
    ])
    return response.trim()
  }
}

// ─── Score cache ─────────────────────────────────────────────────────────────

function loadScoreCache(cachePath: string, maxAgeSeconds: number): ScoreCacheFile | null {
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as ScoreCacheFile
    if (!data.scores) return null
    // Prune entries older than maxAge
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds
    const pruned: ScoreCacheFile['scores'] = {}
    let kept = 0
    let dropped = 0
    for (const [id, entry] of Object.entries(data.scores)) {
      if (entry.createdAt >= cutoff) {
        pruned[id] = entry
        kept++
      } else {
        dropped++
      }
    }
    if (dropped > 0) {
      log(`Score cache: pruned ${dropped} old entries, kept ${kept}`)
    }
    return { ...data, scores: pruned }
  } catch {
    return null
  }
}

function saveScoreCache(cachePath: string, cache: ScoreCacheFile): void {
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2))
    log(`Saved ${Object.keys(cache.scores).length} scores to ${cachePath}`)
  } catch (err) {
    log(`Warning: could not save score cache: ${(err as Error).message}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig()

  const pubkeyHex = pubkeyToHex(config.npub)
  log(`Pubkey: ${pubkeyHex.slice(0, 12)}...`)

  // Create library instances
  const fetcher = createFetcher({ relays: config.relays })
  const ranker = createRanker({
    apiBaseUrl: config.rankingApi.apiBaseUrl,
    apiKey: config.rankingApi.apiKey,
    model: config.rankingApi.model,
    batchSize: config.rankingApi.batchSize,
  })

  try {
    // 1. Get follows
    log('Fetching follow list...')
    const follows = await fetcher.getFollows(pubkeyHex)
    log(`Found ${follows.length} follows`)

    if (follows.length === 0) {
      throw new Error('No follows found for this pubkey. Check the npub in your config.')
    }

    // 2. Fetch posts
    log(`Fetching posts from the last ${config.hoursBack} hours...`)
    const posts = await fetcher.getPosts(follows, {
      hoursBack: config.hoursBack,
      maxPosts: 500,
    })
    log(`Fetched ${posts.length} posts`)

    if (posts.length === 0) {
      throw new Error('No posts found in the specified time range.')
    }

    // 3. Fetch profiles for author names
    const authorPubkeys = [...new Set(posts.map((p) => p.author))]
    log(`Fetching profiles for ${authorPubkeys.length} authors...`)
    const profiles = await fetcher.getProfiles(authorPubkeys)
    log(`Resolved ${profiles.size} profiles`)

    // 4. Evolve learned prompt from likes
    let learnedPrompt: string | undefined
    if (config.learnFromLikes) {
      const cachePath = resolve(config.learnedPromptCache ?? './digest.learned.json')
      const cached = loadLearnedPrompt(cachePath)

      if (cached) {
        log(`Loaded existing learned prompt (last updated: ${cached.updatedAt})`)
        learnedPrompt = cached.prompt
      }

      // Fetch likes newer than what we last processed
      const sinceTimestamp = cached?.lastLikeTimestamp
        ? cached.lastLikeTimestamp + 1
        : undefined
      log(sinceTimestamp
        ? `Fetching likes since ${new Date(sinceTimestamp * 1000).toISOString()}...`
        : 'Fetching likes (first run)...')
      const likes = await fetcher.getLikes(pubkeyHex, {
        limit: 200,
        ...(sinceTimestamp ? { since: sinceTimestamp } : {}),
      })

      if (likes.length > 0) {
        log(`Found ${likes.length} new likes, evolving learned prompt...`)
        const learnerCfg = config.learnerApi ?? config.rankingApi
        const llmConfig: LLMConfig = {
          apiBaseUrl: learnerCfg.apiBaseUrl,
          apiKey: learnerCfg.apiKey,
          model: learnerCfg.model,
        }

        try {
          const evolved = await evolveLearnedPrompt(learnedPrompt, likes, llmConfig)
          if (evolved) {
            learnedPrompt = evolved
            log(`Learned prompt: ${learnedPrompt.slice(0, 100)}...`)

            // Find the most recent like timestamp for next run's since filter
            // Likes don't have timestamps directly, but we fetched with since,
            // so use current time as the high-water mark
            const newHighWater = Math.floor(Date.now() / 1000)

            saveLearnedPrompt(cachePath, {
              prompt: learnedPrompt,
              updatedAt: new Date().toISOString(),
              lastLikeTimestamp: newHighWater,
            })
          } else {
            log('Warning: LLM returned empty learned prompt, skipping save')
          }
        } catch (err) {
          log(`Warning: failed to evolve learned prompt: ${(err as Error).message}`)
          // Continue with whatever we had cached (or undefined)
        }
      } else {
        log('No new likes since last run, keeping existing learned prompt')
      }
    }

    // 5. Score posts (with caching)
    const scoreCachePath = resolve(config.scoreCachePath ?? './digest.scores.json')
    // Keep cached scores for up to 48 hours (posts older than hoursBack get pruned)
    const maxCacheAge = Math.max((config.hoursBack ?? 24) * 2, 48) * 3600
    const scoreCache = loadScoreCache(scoreCachePath, maxCacheAge)

    // Split posts into cached and uncached
    const cachedScores = new Map<string, { score: number; justification?: string }>()
    const uncachedPosts: FetchedPost[] = []

    for (const post of posts) {
      const cached = scoreCache?.scores[post.id]
      if (cached) {
        cachedScores.set(post.id, { score: cached.score, justification: cached.justification })
      } else {
        uncachedPosts.push(post)
      }
    }

    log(`Scores: ${cachedScores.size} cached, ${uncachedPosts.length} to score`)

    // Score only the uncached posts
    let newScoredPosts: ScoredPost[] = []
    if (uncachedPosts.length > 0) {
      log(`Scoring ${uncachedPosts.length} posts with ${config.rankingApi.model}...`)
      const debug: DebugEntry[] = []
      newScoredPosts = await ranker.score(uncachedPosts, {
        userPrompt: config.userPrompt,
        learnedPrompt,
        profiles,
        debug,
        onProgress: (scored, total) => {
          log(`  Scored ${scored}/${total}`)
        },
      })

      const realScored = newScoredPosts.filter((p) => !p.defaultScore).length
      const defaulted = newScoredPosts.filter((p) => p.defaultScore).length
      log(`Scoring done: ${realScored} scored by LLM, ${defaulted} got default score`)
    }

    // Merge cached + new scores into full scored post list
    const allScoredPosts: ScoredPost[] = posts.map((post) => {
      // Check if it was newly scored
      const newScore = newScoredPosts.find((sp) => sp.id === post.id)
      if (newScore) return newScore

      // Use cached score
      const cached = cachedScores.get(post.id)
      if (cached) {
        return {
          ...post,
          score: cached.score,
          justification: cached.justification,
        }
      }

      // Should not happen, but fallback
      return { ...post, score: 5, defaultScore: true }
    })

    // Update score cache with all current scores (new + existing)
    const updatedCache: ScoreCacheFile = {
      updatedAt: new Date().toISOString(),
      scores: { ...(scoreCache?.scores ?? {}) },
    }
    for (const sp of allScoredPosts) {
      if (!sp.defaultScore) {
        updatedCache.scores[sp.id] = {
          score: sp.score,
          justification: sp.justification,
          createdAt: sp.createdAt,
        }
      }
    }
    saveScoreCache(scoreCachePath, updatedCache)

    // 6. Take top N
    const topN = config.topN ?? 15
    const sorted = sortByRelevance(allScoredPosts)
    const topPosts = sorted.slice(0, topN)
    log(`Top ${topPosts.length} posts selected (scores: ${topPosts[0]?.score ?? 0} to ${topPosts[topPosts.length - 1]?.score ?? 0})`)

    // 7. Build digest prompt
    const postsBlock = topPosts
      .map((post, i) => formatPostForDigest(post, i, profiles))
      .join('\n\n')

    const digestUserPrompt = `${config.digestPrompt}

=== User's Interests ===
${config.userPrompt}
${learnedPrompt ? `\n=== Learned Preferences ===\n${learnedPrompt}` : ''}

=== Top ${topPosts.length} Posts (ranked by relevance) ===

${postsBlock}`

    // 8. Generate digest
    log(`Generating digest with ${config.digestApi.model}...`)
    const digest = await chatCompletion(
      {
        apiBaseUrl: config.digestApi.apiBaseUrl,
        apiKey: config.digestApi.apiKey,
        model: config.digestApi.model,
      },
      [
        { role: 'system', content: config.digestSystemPrompt! },
        { role: 'user', content: digestUserPrompt },
      ],
      false,
      config.digestApi.temperature ?? 0.7
    )

    // 9. Output to stdout
    process.stdout.write(digest)
    process.stdout.write('\n')

    log('Done!')
  } finally {
    fetcher.destroy()
  }
}

main().catch((err) => {
  process.stderr.write(`\n[digest] Fatal error: ${(err as Error).message}\n`)
  process.exit(1)
})
