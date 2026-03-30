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
  createLearner,
  chatCompletion,
  pubkeyToHex,
  sortByRelevance,
} from 'nalgorithm'
import type {
  ScoredPost,
  ProfileData,
  DebugEntry,
} from 'nalgorithm'

import { loadConfig } from './config.js'

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

    // 4. Optionally learn from likes
    let learnedPrompt: string | undefined
    if (config.learnFromLikes) {
      log('Fetching likes for preference learning...')
      const likes = await fetcher.getLikes(pubkeyHex, { limit: 200 })
      log(`Fetched ${likes.length} liked posts`)

      if (likes.length > 0) {
        const learnerCfg = config.learnerApi ?? config.rankingApi
        log(`Generating learned preference prompt with ${learnerCfg.model}...`)
        const learner = createLearner({
          apiBaseUrl: learnerCfg.apiBaseUrl,
          apiKey: learnerCfg.apiKey,
          model: learnerCfg.model,
        })
        learnedPrompt = await learner.summarizeLikes(likes)
        if (learnedPrompt) {
          log(`Learned prompt: ${learnedPrompt.slice(0, 100)}...`)
        }
      }
    }

    // 5. Score posts
    log(`Scoring ${posts.length} posts with ${config.rankingApi.model}...`)
    const debug: DebugEntry[] = []
    const scoredPosts = await ranker.score(posts, {
      userPrompt: config.userPrompt,
      learnedPrompt,
      profiles,
      debug,
      onProgress: (scored, total) => {
        log(`  Scored ${scored}/${total}`)
      },
    })

    // Log scoring stats
    const realScored = scoredPosts.filter((p) => !p.defaultScore).length
    const defaulted = scoredPosts.filter((p) => p.defaultScore).length
    log(`Scoring done: ${realScored} scored by LLM, ${defaulted} got default score`)

    // 6. Take top N
    const topN = config.topN ?? 15
    const sorted = sortByRelevance(scoredPosts)
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
