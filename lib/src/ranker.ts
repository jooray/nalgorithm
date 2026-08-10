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
const DEFAULT_CONCURRENCY = 1

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

/** Keys a model might plausibly use for the post number, score, and reason. */
const INDEX_KEYS = ['post_number', 'postNumber', 'post', 'index', 'idx', 'number', 'n', 'id']
const SCORE_KEYS = ['score', 'relevance', 'rating', 'value']
const REASON_KEYS = ['justification', 'reason', 'explanation', 'why', 'rationale']

/**
 * Strip reasoning-model artefacts that leak into the content field.
 *
 * Some Venice models emit their `<think>` block into `content` rather than
 * `reasoning_content`, and under `response_format: json_object` the leaked tag
 * can end up *inside* the JSON. Removing it first rescues an otherwise fine
 * response.
 */
function stripThinkBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

/** Pull the first value present under any of `keys`. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return undefined
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value
  if (typeof value === 'string') {
    const n = parseInt(value, 10)
    if (!isNaN(n)) return n
  }
  return null
}

/**
 * Coerce one entry into [index, score, justification].
 *
 * Accepts the documented tuple form, and also the object form
 * (`{post_number, score, justification}`) that models drift into under JSON
 * mode. `fallbackIndex` supplies the position when the entry carries no index
 * of its own, which is how object-keyed maps and bare score lists are handled.
 */
function coerceEntry(item: unknown, fallbackIndex: number | null): [number, number, string] | null {
  let idxRaw: unknown
  let scoreRaw: unknown
  let reasonRaw: unknown

  if (Array.isArray(item)) {
    if (item.length >= 3) {
      ;[idxRaw, scoreRaw, reasonRaw] = item
    } else if (item.length === 2) {
      // Either [index, score] or [score, justification]
      if (typeof item[1] === 'string') {
        ;[scoreRaw, reasonRaw] = item
      } else {
        ;[idxRaw, scoreRaw] = item
      }
    } else {
      return null
    }
  } else if (item !== null && typeof item === 'object') {
    const obj = item as Record<string, unknown>
    idxRaw = pick(obj, INDEX_KEYS)
    scoreRaw = pick(obj, SCORE_KEYS)
    reasonRaw = pick(obj, REASON_KEYS)
  } else if (typeof item === 'number') {
    scoreRaw = item
  } else {
    return null
  }

  const score = toNumber(scoreRaw)
  if (score === null) return null

  const idx = toNumber(idxRaw) ?? fallbackIndex
  if (idx === null) return null

  return [idx, Math.max(0, Math.min(10, score)), typeof reasonRaw === 'string' ? reasonRaw : '']
}

/**
 * Reduce whatever the model returned to a flat list of entries.
 *
 * Handles: a bare array; an object wrapping the array under any key
 * (`{scores: [...]}`, `{posts: [...]}`); and an object keyed by post number
 * (`{"1": {...}, "2": {...}}`).
 */
function toEntryList(parsed: unknown): Array<{ item: unknown; fallbackIndex: number | null }> {
  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => ({ item, fallbackIndex: i + 1 }))
  }

  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const entries = Object.entries(obj)

    // An object keyed by post number. Checked first: `{"1": [1, 9, "…"]}` is
    // all-numeric-keyed *and* has array values, so the wrapper branch below
    // would otherwise mistake the first entry's tuple for the whole list.
    if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
      return entries.map(([key, item]) => ({ item, fallbackIndex: parseInt(key, 10) }))
    }

    // An object wrapping the real array under some key. Prefer an array whose
    // elements are themselves entries over one holding bare scalars.
    const arrays = entries.map(([, v]) => v).filter(Array.isArray) as unknown[][]
    const structured = arrays.find((arr) =>
      arr.some((el) => Array.isArray(el) || (el !== null && typeof el === 'object'))
    )
    const chosen = structured ?? arrays[0]
    if (chosen) {
      return chosen.map((item, i) => ({ item, fallbackIndex: i + 1 }))
    }
  }

  return []
}

/**
 * Pull individually-complete entries out of text that does not parse as JSON.
 *
 * Matches both the tuple form and the object form, anchored on their own
 * brackets, so a response truncated mid-entry still yields everything that
 * arrived intact before the cut.
 */
function salvageEntries(text: string): Array<{ item: unknown; fallbackIndex: number | null }> {
  const out: Array<{ item: unknown; fallbackIndex: number | null }> = []

  // [12, 8, "some justification"] — the documented shape.
  const tuple = /\[\s*(\d+)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*("(?:[^"\\]|\\.)*"))?\s*\]/g
  for (const m of text.matchAll(tuple)) {
    let reason = ''
    if (m[3]) {
      try {
        reason = JSON.parse(m[3]) as string
      } catch {
        reason = ''
      }
    }
    out.push({ item: [Number(m[1]), Number(m[2]), reason], fallbackIndex: null })
  }
  if (out.length > 0) return out

  // {"post_number": 12, "score": 8, "justification": "..."} — the object shape.
  const object = /\{[^{}]*\}/g
  for (const m of text.matchAll(object)) {
    try {
      out.push({ item: JSON.parse(m[0]), fallbackIndex: null })
    } catch {
      // Incomplete object at the truncation point — skip it.
    }
  }
  return out
}

/**
 * Validate the LLM response against the expected schema.
 *
 * The documented contract is an array of `[post_number, score, justification]`,
 * but models drift — especially under `response_format: json_object`, which
 * requires a top-level object and so pushes them into wrapper shapes. Rather
 * than defaulting a whole batch to score 5 over a cosmetic difference, this
 * accepts the common variants and reports what it had to coerce.
 */
function validateScoreResponse(
  raw: string,
  postCount: number
): { scores: Array<[number, number, string]>; error?: string } | null {
  const cleaned = stripThinkBlocks(raw)

  // Try progressively looser extractions and keep the first that yields entries.
  const candidates: string[] = []
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())
  candidates.push(cleaned)
  const arrayMatch = cleaned.match(/(\[[\s\S]*\])/)
  if (arrayMatch) candidates.push(arrayMatch[1])
  const objectMatch = cleaned.match(/(\{[\s\S]*\})/)
  if (objectMatch) candidates.push(objectMatch[1])

  let entries: Array<{ item: unknown; fallbackIndex: number | null }> = []
  let parseFailed = true

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    parseFailed = false
    const found = toEntryList(parsed)
    if (found.length > 0) {
      entries = found
      break
    }
  }

  // Last resort: scavenge whole entries out of text that will not parse.
  // The usual cause is truncation — the provider cut the response mid-array,
  // so the JSON is invalid but the entries before the cut are perfectly good.
  // Salvaging them beats giving the whole batch the fallback score.
  let salvaged = false
  if (entries.length === 0) {
    const found = salvageEntries(cleaned)
    if (found.length > 0) {
      entries = found
      salvaged = true
    }
  }

  if (entries.length === 0) {
    return {
      scores: [],
      error: parseFailed
        ? 'Failed to parse LLM response as JSON'
        : 'LLM response contained no recognizable score entries',
    }
  }

  const results: Array<[number, number, string]> = []
  const errors: string[] = []

  for (const { item, fallbackIndex } of entries) {
    const coerced = coerceEntry(item, fallbackIndex)
    if (!coerced) {
      errors.push(`Unrecognized entry: ${JSON.stringify(item).slice(0, 120)}`)
      continue
    }
    const [idx, score, justification] = coerced
    if (idx < 1 || idx > postCount) {
      errors.push(`Index out of range: ${idx} (expected 1-${postCount})`)
      continue
    }
    results.push([idx, score, justification])
  }

  if (results.length === 0) {
    return { scores: [], error: `No valid scores parsed. Errors: ${errors.join('; ')}` }
  }

  const notes: string[] = []
  if (salvaged) {
    notes.push(`Salvaged ${results.length} entries from unparseable output (likely truncated)`)
  }
  if (errors.length > 0) {
    notes.push(`Partial parse (${results.length}/${entries.length}): ${errors.join('; ')}`)
  }
  return { scores: results, error: notes.length > 0 ? notes.join('. ') : undefined }
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
  const concurrency = Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY)
  const jsonMode = config.jsonMode ?? false
  const llmConfig: LLMConfig = {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
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
        jsonMode
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

    let scoredSoFar = 0
    const totalPosts = posts.length

    /**
     * Score batches through a worker pool.
     *
     * Each worker takes the next unclaimed batch the moment it finishes one, so
     * `concurrency` requests stay in flight for the whole run. The obvious
     * alternative — awaiting a fixed window of N batches before starting the
     * next N — idles every fast batch until the slowest in its window returns,
     * and LLM latency varies enough for that to cost most of the speedup.
     *
     * `nextBatch++` needs no lock: JS runs this synchronously, and there is no
     * await between reading the index and incrementing it.
     */
    let nextBatch = 0
    const workerCount = Math.min(concurrency, batches.length)

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextBatch++
        if (index >= batches.length) return

        // scoreBatch handles its own errors and falls back to default scores,
        // so one bad batch cannot kill a worker and strand the rest.
        const batchScores = await scoreBatch(
          batches[index],
          options.userPrompt,
          options.learnedPrompt,
          index,
          options.debug,
          options.profiles
        )

        for (const [id, data] of batchScores) {
          allScores.set(id, data)
        }

        // Hand this batch to the caller straight away so it can be cached.
        // Holding everything until the whole run resolves loses the lot on a
        // reload or a crash.
        if (options.onBatchScored) {
          options.onBatchScored(
            batches[index].map((post) => {
              const data = batchScores.get(post.id)
              return {
                ...post,
                score: data?.score ?? DEFAULT_SCORE,
                justification: data?.justification || undefined,
                defaultScore: data?.defaultScore || undefined,
              }
            })
          )
        }

        // Progress reflects completion order, not batch order — with a pool
        // those differ, and the count is what the caller displays.
        scoredSoFar += batches[index].length
        options.onProgress?.(scoredSoFar, totalPosts)
      }
    }

    await Promise.all(Array.from({ length: workerCount }, worker))

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
