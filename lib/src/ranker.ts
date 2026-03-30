/**
 * Nalgorithm — Ranker module
 *
 * Scores posts for relevance using an LLM. Sends posts in batches
 * using short numeric indexes (not hex IDs) to avoid LLM truncation.
 * Validates the JSON response and returns sorted results with justifications.
 */

import { chatCompletionWithRetry } from './llm.js'
import type {
  RankerConfig,
  Ranker,
  FetchedPost,
  ScoredPost,
  ScoreOptions,
  DebugEntry,
  LLMConfig,
  ProfileData,
} from './types.js'

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_SCORE = 5

/**
 * Sort scored posts by relevance (descending), then by time (descending) as tiebreaker.
 */
export function sortByRelevance(posts: ScoredPost[]): ScoredPost[] {
  return [...posts].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.createdAt - a.createdAt
  })
}

/**
 * Resolve a pubkey to a short display name using profiles, or a short hex fallback.
 */
function resolveAuthorName(
  pubkey: string,
  profiles?: Map<string, ProfileData>
): string {
  const profile = profiles?.get(pubkey)
  if (profile?.name) return profile.name
  return pubkey.slice(0, 8)
}

/**
 * Format a single post for inclusion in the LLM scoring prompt.
 * Uses a 1-based numeric index instead of the hex event ID.
 * Resolves author pubkeys to display names when profiles are available.
 * Strips all nostr: references from content.
 */
function formatPostForPrompt(
  post: FetchedPost,
  index: number,
  profiles?: Map<string, ProfileData>
): string {
  const num = index + 1

  if (post.type === 'boost' && post.originalPost) {
    const boosterName = resolveAuthorName(post.author, profiles)
    const content = stripNostrRefs(post.originalPost.content)
    return `${num}. [Boosted by ${boosterName}] "${truncate(content, 500)}"`
  }

  if (post.type === 'quote' && post.quotedPost) {
    const quoterName = resolveAuthorName(post.author, profiles)
    const quoteText = stripNostrRefs(post.content)
    const quotedText = stripNostrRefs(post.quotedPost.content)
    return `${num}. [Quote by ${quoterName}] "${truncate(quoteText, 300)}" — Quoted post: "${truncate(quotedText, 300)}"`
  }

  return `${num}. "${truncate(stripNostrRefs(post.content), 500)}"`
}

/**
 * Strip nostr: references from content for cleaner LLM input.
 */
function stripNostrRefs(content: string): string {
  return content.replace(/nostr:n(event|ote|pub|profile|addr)1[a-z0-9]+/gi, '[referenced post]').trim()
}

/**
 * Truncate text to a max length, adding ellipsis if needed.
 */
function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\n+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen) + '...'
}

/**
 * Build the system prompt for the scoring LLM call.
 */
function buildSystemPrompt(): string {
  return `You are a Nostr post relevance scorer. You receive a user's interest profile and a batch of numbered posts. You score each post for personal relevance to that user.

## Response format

Return a JSON array containing one entry per post. Each entry is a 3-element array:

  [post_number, score, justification]

Where:
- post_number (integer): the number shown before the post (1, 2, 3, ...). Every post must have exactly one entry.
- score (integer, 0-10): relevance to the user's interests.
- justification (string): one sentence explaining why this score was given.

Return ONLY the JSON array. No markdown code fences, no commentary, no extra text.

Example — if there are 5 posts to score, your response looks exactly like this:

[
  [1, 8, "Directly discusses Bitcoin privacy tools the user cares about"],
  [2, 2, "Generic meme with no connection to user interests"],
  [3, 6, "Tangentially related to decentralization but lacks depth"],
  [4, 0, "Spam account promoting unrelated product"],
  [5, 9, "In-depth analysis of Lightning Network scaling, core interest"]
]

## Scoring mechanics

- Score boosted posts based on the ORIGINAL content being boosted, not the boost action itself.
- Score quote posts based on BOTH the quote commentary and the embedded post together.
- Short low-effort posts ("GM", single emoji, etc.) should score low unless the user's profile explicitly values casual social interaction.
- A post matching multiple user interests scores higher than one matching a single interest.`
}

/**
 * Build the user prompt for a scoring batch.
 */
function buildUserPrompt(
  posts: FetchedPost[],
  userPrompt: string,
  learnedPrompt?: string,
  profiles?: Map<string, ProfileData>
): string {
  const parts: string[] = []

  parts.push(`Score each post below from 0 to 10 based on how relevant it is to this user's interests and preferences.

Scoring scale:
- 9-10: Directly about a core interest, substantive, high signal. The user would actively seek this out.
- 7-8: Clearly relevant to a listed interest, reasonable depth or insight.
- 5-6: Tangentially related to user interests, or generic content that isn't off-topic.
- 3-4: Mostly irrelevant but not objectionable. Weak or indirect connection at best.
- 1-2: Off-topic, low-effort, or noise. No meaningful connection to the user's interests.
- 0: Spam, completely irrelevant, or content the user explicitly wants filtered out.`)

  parts.push('')
  parts.push('=== User Profile ===')
  parts.push(userPrompt)

  if (learnedPrompt && learnedPrompt.trim()) {
    parts.push('')
    parts.push('=== Learned Preferences (from user behavior) ===')
    parts.push(learnedPrompt)
  }

  parts.push('')
  parts.push('=== Posts to Score ===')
  posts.forEach((post, i) => {
    parts.push(formatPostForPrompt(post, i, profiles))
  })

  parts.push('')
  parts.push(`Score all ${posts.length} posts. Respond with JSON only.`)

  return parts.join('\n')
}

/**
 * Validate the LLM response JSON against the expected schema.
 *
 * Expected: array of [number, number, string] where each first number is
 * a 1-based post index and each second number is 0-10.
 *
 * Returns validated scores or null if validation fails entirely.
 */
function validateScoreResponse(
  raw: string,
  postCount: number
): { scores: Array<[number, number, string]>; error?: string } | null {
  let parsed: unknown
  try {
    // Try to extract JSON from the response (handles markdown code blocks)
    let jsonStr = raw.trim()
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }
    // Also handle case where response starts with text before JSON
    const arrayMatch = jsonStr.match(/(\[[\s\S]*\])/)
    if (arrayMatch) {
      jsonStr = arrayMatch[1]
    }
    parsed = JSON.parse(jsonStr)
  } catch {
    return { scores: [], error: 'Failed to parse LLM response as JSON' }
  }

  if (!Array.isArray(parsed)) {
    return { scores: [], error: 'LLM response is not an array' }
  }

  const results: Array<[number, number, string]> = []
  const errors: string[] = []

  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 2) {
      errors.push(`Invalid entry (not an array or too short): ${JSON.stringify(item)}`)
      continue
    }

    const [idx, score, justification] = item
    const numIdx = typeof idx === 'string' ? parseInt(idx, 10) : idx

    if (typeof numIdx !== 'number' || isNaN(numIdx)) {
      errors.push(`Invalid index type: ${JSON.stringify(idx)}`)
      continue
    }

    if (typeof score !== 'number') {
      errors.push(`Invalid score type for index ${numIdx}: ${typeof score}`)
      continue
    }

    if (numIdx < 1 || numIdx > postCount) {
      errors.push(`Index out of range: ${numIdx} (expected 1-${postCount})`)
      continue
    }

    const clampedScore = Math.max(0, Math.min(10, score))
    const justStr = typeof justification === 'string' ? justification : ''
    results.push([numIdx, clampedScore, justStr])
  }

  if (results.length === 0) {
    return { scores: [], error: `No valid scores parsed. Errors: ${errors.join('; ')}` }
  }

  const error = errors.length > 0 ? `Partial parse (${results.length}/${parsed.length}): ${errors.join('; ')}` : undefined
  return { scores: results, error }
}

/**
 * Chunk an array into smaller arrays.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

/**
 * Create a Ranker instance.
 */
export function createRanker(config: RankerConfig): Ranker {
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
  const llmConfig: LLMConfig = {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
  }

  async function scoreBatch(
    posts: FetchedPost[],
    userPrompt: string,
    learnedPrompt: string | undefined,
    batchIndex: number,
    debug?: DebugEntry[],
    profiles?: Map<string, ProfileData>
  ): Promise<Map<string, { score: number; justification: string; defaultScore?: boolean }>> {
    const systemPrompt = buildSystemPrompt()
    const userMsg = buildUserPrompt(posts, userPrompt, learnedPrompt, profiles)

    const scoreMap = new Map<string, { score: number; justification: string; defaultScore?: boolean }>()
    let rawResponse: string | undefined
    let debugError: string | undefined

    try {
      rawResponse = await chatCompletionWithRetry(
        llmConfig,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        true // JSON mode
      )

      const result = validateScoreResponse(rawResponse, posts.length)

      if (result && result.scores.length > 0) {
        for (const [idx, score, justification] of result.scores) {
          // idx is 1-based, map back to post
          const post = posts[idx - 1]
          if (post) {
            scoreMap.set(post.id, { score, justification })
          }
        }
        if (result.error) {
          debugError = result.error
        }
      } else {
        debugError = result?.error ?? 'Validation returned no scores'
      }
    } catch (err) {
      debugError = `LLM call failed: ${(err as Error).message}`
    }

    // Push debug info if consumer wants it
    if (debug) {
      debug.push({
        batch: batchIndex,
        rawResponse,
        error: debugError,
        postCount: posts.length,
        scoredCount: scoreMap.size,
      })
    }

    // Log warnings to console for debugging
    if (debugError) {
      console.warn(`[Ranker] Batch ${batchIndex}: ${debugError}`)
    }

    // Assign default score to any posts that didn't get scored
    for (const post of posts) {
      if (!scoreMap.has(post.id)) {
        scoreMap.set(post.id, { score: DEFAULT_SCORE, justification: '', defaultScore: true })
      }
    }

    return scoreMap
  }

  async function score(
    posts: FetchedPost[],
    options: ScoreOptions
  ): Promise<ScoredPost[]> {
    if (posts.length === 0) return []

    const batches = chunk(posts, batchSize)
    const allScores = new Map<string, { score: number; justification: string; defaultScore?: boolean }>()

    // Process batches sequentially to avoid rate limiting
    let scoredSoFar = 0
    for (let i = 0; i < batches.length; i++) {
      const batchScores = await scoreBatch(
        batches[i],
        options.userPrompt,
        options.learnedPrompt,
        i,
        options.debug,
        options.profiles
      )
      for (const [id, data] of batchScores) {
        allScores.set(id, data)
      }
      scoredSoFar += batches[i].length
      if (options.onProgress) {
        options.onProgress(scoredSoFar, posts.length)
      }
    }

    // Build scored posts
    const scoredPosts: ScoredPost[] = posts.map((post) => {
      const data = allScores.get(post.id)
      return {
        ...post,
        score: data?.score ?? DEFAULT_SCORE,
        justification: data?.justification || undefined,
        defaultScore: data?.defaultScore || undefined,
      }
    })

    return sortByRelevance(scoredPosts)
  }

  return { score }
}
