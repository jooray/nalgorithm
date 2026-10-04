/**
 * Nalgorithm — pipeline
 *
 * The orchestration that used to live in the digest CLI: learned-prompt
 * evolution, cache-aware scoring, and digest writing with a fallback model.
 * It sits in the library so the CLI and a hosted service run the same code.
 *
 * The library stays stateless. Everything that persists goes through
 * {@link PipelineStore}, so a caller picks JSON files, SQLite or memory.
 */

import { chatCompletionWithRetry } from './llm.js'
import { buildDigestMessages } from './digest.js'
import { humanizeText } from './humanizer.js'
import { scoreCacheKey } from './ranker.js'
import { contextualScoreKey } from './ranking-context.js'
import type { DigestOptions } from './digest.js'
import type {
  Fetcher,
  FetchedPost,
  LLMConfig,
  Ranker,
  ScoredPost,
  ScorerKind,
  ProfileData,
  DebugEntry,
} from './types.js'

// ─── Store and logger ────────────────────────────────────────────────────────

export interface CachedScore {
  score: number
  justification?: string
  /** Unix timestamp (seconds) of the post */
  createdAt: number
  /**
   * Which scorer produced it. Absent means chat, so caches written before the
   * decision scorer existed stay valid without a re-score.
   */
  scorer?: 'decision'
}

export interface LearnedState {
  backfillUntil?: number
  latestReactionTimestamp?: number
  processedReactionIds?: string[]
  prompt: string
  updatedAt: string
  /** Unix timestamp (seconds) of the most recent like that was processed */
  lastLikeTimestamp?: number
}

/** Persistence for one user. Implementations decide the backing store. */
export interface PipelineStore {
  getLearned(): Promise<LearnedState | null>
  putLearned(state: LearnedState): Promise<void>
  /** Look up cached scores. Missing keys are simply absent from the result. */
  getScores(keys: string[]): Promise<Record<string, CachedScore>>
  putScores(entries: Record<string, CachedScore>): Promise<void>
  /** Write anything still buffered. Called once scoring finishes. */
  flush?(): Promise<void>
}

export interface PipelineLogger {
  info(message: string): void
  warn(message: string): void
}

export const silentLogger: PipelineLogger = { info() {}, warn() {} }

// ─── Learned prompt ──────────────────────────────────────────────────────────

/**
 * Evolve the learned prompt by incorporating new likes.
 *
 * Likes go through in batches so smaller context windows cope. With an existing
 * prompt each batch refines it; without one, the first batch writes it from
 * scratch and later batches evolve that.
 */
export async function evolveLearnedPrompt(
  existingPrompt: string | undefined,
  newLikes: Array<{ content: string }>,
  llmConfig: LLMConfig,
  options: { batchSize?: number; pauseMs?: number; log?: PipelineLogger } = {},
): Promise<string> {
  const { batchSize = 50, pauseMs = 1000, log = silentLogger } = options
  if (newLikes.length === 0) return existingPrompt ?? ''

  const batches: Array<Array<{ content: string }>> = []
  for (let i = 0; i < newLikes.length; i += batchSize) {
    batches.push(newLikes.slice(i, i + batchSize))
  }

  log.info(`Evolving learned prompt in ${batches.length} batch(es) of up to ${batchSize} likes`)

  let currentPrompt = existingPrompt

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const likesList = batch
      .map((l, i) => `${i + 1}. "${l.content.replace(/\n+/g, ' ').trim().slice(0, 300)}"`)
      .join('\n')

    if (currentPrompt) {
      const response = await chatCompletionWithRetry(llmConfig, [
        {
          role: 'system',
          content: 'You refine user preference summaries based on new engagement data. Be concise and specific. Output only the updated summary text, no JSON, no markdown.',
        },
        {
          role: 'user',
          content: `Here is the current summary of a user's preferences based on their past Nostr likes:

${currentPrompt}

The user has recently liked these additional posts (batch ${b + 1}/${batches.length}):

${likesList}

Update the preference summary to incorporate any new patterns or interests from these recent likes. Keep what's still relevant, adjust emphasis if needed, add new themes if they appear. Stay concise (2-5 sentences). If the new likes are consistent with the existing summary, only make minor refinements.

Updated summary:`,
        },
      ])
      currentPrompt = response.trim()
    } else {
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
      currentPrompt = response.trim()
    }

    log.info(`  Batch ${b + 1}/${batches.length} done: "${currentPrompt.slice(0, 80)}..."`)

    // Small pause between batches to avoid rate-limit bursts
    if (b < batches.length - 1 && pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
    }
  }

  return currentPrompt ?? ''
}

export interface RefreshLearnedOptions {
  fetcher: Fetcher
  store: PipelineStore
  /** The model that writes the summary. */
  llm: LLMConfig
  pubkeyHex: string
  log?: PipelineLogger
  /** Likes per LLM call (default: 50). */
  batchSize?: number
  /** Clock, for tests. */
  now?: () => number
  /** Pause between batches in ms (default: 1000). */
  pauseMs?: number
}

/**
 * Fetch likes newer than the stored high-water mark and fold them into the
 * stored learned prompt. Returns the prompt to use, or undefined if there is
 * none. A failure keeps whatever was stored, so this never throws for LLM
 * trouble.
 */
export async function refreshLearnedPrompt(opts: RefreshLearnedOptions): Promise<string | undefined> {
  const { fetcher, store, llm, pubkeyHex, log = silentLogger, batchSize = 50 } = opts
  const now = opts.now ?? (() => Date.now())

  const cached = await store.getLearned()
  let learnedPrompt: string | undefined
  if (cached) {
    log.info(`Loaded existing learned prompt (last updated: ${cached.updatedAt})`)
    learnedPrompt = cached.prompt
  }

  const sinceTimestamp = cached?.lastLikeTimestamp ? Math.max(0, cached.lastLikeTimestamp - 300) : undefined
  const fetchedAt = Math.floor(now() / 1000)
  log.info(
    sinceTimestamp
      ? `Fetching likes since ${new Date(sinceTimestamp * 1000).toISOString()}...`
      : 'Fetching likes (first run)...',
  )
  const fetchedLikes = await fetcher.getLikes(pubkeyHex, {
    limit: 200,
    ...(sinceTimestamp !== undefined ? { since: sinceTimestamp } : {}),
    ...(cached?.backfillUntil !== undefined ? { until: cached.backfillUntil } : {}),
  })
  const processed = new Set(cached?.processedReactionIds ?? [])
  const likes = fetchedLikes.filter((like) => !processed.has(like.reactionId ?? like.id))
  const fullPage = (fetchedLikes.reactionCount ?? fetchedLikes.length) >= 200
  const latestReactionTimestamp = Math.max(cached?.latestReactionTimestamp ?? cached?.lastLikeTimestamp ?? 0, ...fetchedLikes.map((l) => l.reactedAt ?? fetchedAt))
  const checkpoint = {
    lastLikeTimestamp: fullPage ? cached?.lastLikeTimestamp : latestReactionTimestamp,
    ...(fullPage && fetchedLikes.nextUntil !== undefined ? { backfillUntil: fetchedLikes.nextUntil } : {}),
    latestReactionTimestamp,
  }

  if (likes.length === 0) {
    if (cached && (fullPage || cached.backfillUntil !== undefined)) await store.putLearned({ ...cached, backfillUntil: undefined, ...checkpoint })
    log.info('No new likes since last run, keeping existing learned prompt')
    return learnedPrompt
  }

  log.info(`Found ${likes.length} new likes, evolving learned prompt...`)
  try {
    const evolved = await evolveLearnedPrompt(learnedPrompt, likes, llm, {
      batchSize,
      pauseMs: opts.pauseMs,
      log,
    })
    if (evolved) {
      learnedPrompt = evolved
      log.info(`Learned prompt: ${learnedPrompt.slice(0, 100)}...`)
      // Likes carry no timestamp of their own, and we fetched with `since`,
      // so the current time is the high-water mark for the next run.
      await store.putLearned({
        prompt: learnedPrompt,
        updatedAt: new Date(now()).toISOString(),
        // Never jump over likes created while the model was running. Full pages
        // retain the previous watermark until coverage can be checked again.
        ...checkpoint,
        processedReactionIds: [...processed, ...likes.map((l) => l.reactionId ?? l.id)].slice(-2000),
      })
    } else {
      log.warn('LLM returned empty learned prompt, skipping save')
    }
  } catch (err) {
    log.warn(`failed to evolve learned prompt: ${(err as Error).message}`)
  }
  return learnedPrompt
}

// ─── Cache-aware scoring ─────────────────────────────────────────────────────

export interface ScoreCachedOptions {
  ranker: Ranker
  store: PipelineStore
  /** Which scorer the ranker uses. Cached scores from the other one are ignored. */
  scorer: ScorerKind
  log?: PipelineLogger
}

export interface ScoreCachedInput {
  context?: string
  userPrompt: string
  learnedPrompt?: string
  profiles?: Map<string, ProfileData>
  debug?: DebugEntry[]
  /** Model name, for the log line only. */
  modelLabel?: string
  onProgress?: (scored: number, total: number) => void
}

/**
 * Score posts, paying only for those the store has not seen.
 *
 * Results come back in the order of `posts`. Each batch is written to the
 * store as it lands, so an interrupted run keeps what it already paid for.
 * Posts the ranker could not score (default score) are returned but never
 * cached.
 */
export async function scorePostsCached(
  opts: ScoreCachedOptions,
  posts: FetchedPost[],
  input: ScoreCachedInput,
): Promise<ScoredPost[]> {
  const { ranker, store, scorer, log = silentLogger } = opts

  const keyFor = (post: FetchedPost): string => contextualScoreKey(scoreCacheKey(post), input.context)
  const cached = await store.getScores([...new Set(posts.map(keyFor))])

  const entryFor = (sp: ScoredPost): CachedScore => ({
    score: sp.score,
    justification: sp.justification,
    createdAt: sp.createdAt,
    ...(scorer === 'decision' ? { scorer: 'decision' as const } : {}),
  })

  const cachedById = new Map<string, { score: number; justification?: string }>()
  const uncached: FetchedPost[] = []
  for (const post of posts) {
    // Keyed by the boosted event where there is one, see scoreCacheKey.
    const hit = cached[keyFor(post)]
    // The two scorers sit on different scales (a decision score runs lower),
    // so a score from the other one would mis-rank rather than save a call.
    if (hit && (hit.scorer ?? 'chat') === scorer) {
      cachedById.set(post.id, { score: hit.score, justification: hit.justification })
    } else {
      uncached.push(post)
    }
  }

  log.info(`Scores: ${cachedById.size} cached, ${uncached.length} to score`)

  const newById = new Map<string, ScoredPost>()
  // The ranker calls onBatchScored synchronously, so writes chain onto one
  // promise that is awaited once scoring returns.
  let pending: Promise<void> = Promise.resolve()
  if (uncached.length > 0) {
    log.info(
      `Scoring ${uncached.length} posts${input.modelLabel ? ` with ${input.modelLabel}` : ''} (${scorer} scorer)...`,
    )
    const scored = await ranker.score(uncached, {
      userPrompt: input.userPrompt,
      learnedPrompt: input.learnedPrompt,
      profiles: input.profiles,
      debug: input.debug,
      onProgress: (n, total) => {
        log.info(`  Scored ${n}/${total}`)
        input.onProgress?.(n, total)
      },
      onBatchScored: (batch) => {
        const entries: Record<string, CachedScore> = {}
        for (const sp of batch) {
          if (!sp.defaultScore) entries[keyFor(sp)] = entryFor(sp)
        }
        if (Object.keys(entries).length > 0) {
          pending = pending.then(() => store.putScores(entries))
        }
      },
    })
    await pending
    for (const sp of scored) newById.set(sp.id, sp)

    const real = scored.filter((p) => !p.defaultScore).length
    log.info(`Scoring done: ${real} scored by LLM, ${scored.length - real} got default score`)
  }

  const all = posts.map((post): ScoredPost => {
    const fresh = newById.get(post.id)
    if (fresh) return fresh
    const hit = cachedById.get(post.id)
    if (hit) return { ...post, score: hit.score, justification: hit.justification }
    // Should not happen; keep the post rather than drop it.
    return { ...post, score: 5, defaultScore: true }
  })

  await store.flush?.()
  return all
}

// ─── Digest with fallback and humanizer ──────────────────────────────────────

export interface DigestModel {
  llm: LLMConfig
  /** Passed straight to the completion call; undefined uses its default. */
  temperature?: number
}

export interface WriteDigestOptions {
  primary: DigestModel
  /** Tried once if the primary fails after its own retries. */
  fallback?: DigestModel
  /** Runs an editing pass over the finished digest. Never costs the digest. */
  humanizer?: DigestModel
  digest: DigestOptions
  log?: PipelineLogger
}

/**
 * Write the digest, falling back to a second model if the first fails, then
 * optionally humanize it. The humanizer returns its input on any failure, so
 * this only throws when every digest model has failed.
 */
export async function writeDigest(opts: WriteDigestOptions): Promise<string> {
  const { primary, fallback, humanizer, log = silentLogger } = opts
  const messages = buildDigestMessages(opts.digest)

  let digest: string
  try {
    log.info(`Generating digest with ${primary.llm.model}...`)
    digest = await chatCompletionWithRetry(primary.llm, messages, false, 3, 2000, primary.temperature)
  } catch (primaryErr) {
    if (!fallback) throw primaryErr
    log.warn(
      `Primary digest model failed (${(primaryErr as Error).message}), falling back to ${fallback.llm.model}...`,
    )
    digest = await chatCompletionWithRetry(fallback.llm, messages, false, 3, 2000, fallback.temperature)
  }

  if (humanizer) {
    log.info(`Humanizing with ${humanizer.llm.model}...`)
    const before = digest.length
    digest = await humanizeText(humanizer.llm, digest, {
      forSpeech: true,
      temperature: humanizer.temperature,
      onWarning: (message) => log.warn(message),
    })
    log.info(`Humanizer pass: ${before} chars in, ${digest.length} out`)
  }
  return digest
}
