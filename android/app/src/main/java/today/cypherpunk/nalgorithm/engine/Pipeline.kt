package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.time.Instant

/**
 * The orchestration of lib pipeline.ts: learned-prompt evolution, cache-aware
 * scoring and digest writing with a fallback model. Everything that persists
 * goes through [PipelineStore], so a caller picks the backing store.
 */

@Serializable
data class CachedScore(
    val score: Double,
    val justification: String? = null,
    /** Unix seconds of the post. */
    val createdAt: Long = 0,
    /** Which scorer produced it; absent means chat, as every older entry was. */
    val scorer: String? = null,
)

@Serializable
data class LearnedState(
    val prompt: String,
    /** ISO-8601. */
    val updatedAt: String,
    val backfillUntil: Long? = null,
    val latestReactionTimestamp: Long? = null,
    val processedReactionIds: List<String>? = null,
    /** Unix seconds of the most recent like that was processed. */
    val lastLikeTimestamp: Long? = null,
)

interface PipelineStore {
    suspend fun getLearned(): LearnedState?
    suspend fun putLearned(state: LearnedState)
    /** Missing keys are simply absent from the result. */
    suspend fun getScores(keys: List<String>): Map<String, CachedScore> = emptyMap()
    suspend fun putScores(entries: Map<String, CachedScore>) {}
    suspend fun flush() {}
}

interface PipelineLogger {
    fun info(message: String) {}
    fun warn(message: String) {}

    companion object {
        val silent = object : PipelineLogger {}
    }
}

/** Where likes come from; the [Fetcher] is one, tests use fakes. */
interface LikesSource {
    suspend fun getLikes(pubkeyHex: String, limit: Int = 200, since: Long? = null, until: Long? = null): LikesPage
}

object Pipeline {
    /** How far back catch-up between the watermark and now may reach. */
    const val LEARN_MAX_AGE_SECONDS = 30L * 86_400

    private const val EVOLVE_SYSTEM = "You refine user preference summaries based on new engagement data. Be concise and specific. Output only the updated summary text, no JSON, no markdown."

    /**
     * Fold new likes into the learned prompt, in batches so smaller context windows cope.
     * With an existing prompt each batch refines it; without one, the first writes it.
     */
    suspend fun evolveLearnedPrompt(
        existingPrompt: String?,
        newLikes: List<String>,
        llm: LlmConfig,
        batchSize: Int = 50,
        pauseMs: Long = 1000,
        log: PipelineLogger = PipelineLogger.silent,
        retryBaseDelayMs: Long = 2000,
    ): String {
        if (newLikes.isEmpty()) return existingPrompt ?: ""
        val batches = newLikes.chunked(batchSize)
        log.info("Evolving learned prompt in ${batches.size} batch(es) of up to $batchSize likes")
        var current = existingPrompt
        for ((b, batch) in batches.withIndex()) {
            val likesList = batch.mapIndexed { i, content ->
                "${i + 1}. \"${content.replace(Regex("\n+"), " ").trim().take(300)}\""
            }.joinToString("\n")
            current = if (!current.isNullOrEmpty()) {
                chatCompletionWithRetry(
                    llm,
                    listOf(
                        ChatMessage("system", EVOLVE_SYSTEM),
                        ChatMessage(
                            "user",
                            """Here is the current summary of a user's preferences based on their past Nostr likes:

$current

The user has recently liked these additional posts (batch ${b + 1}/${batches.size}):

$likesList

Update the preference summary to incorporate any new patterns or interests from these recent likes. Keep what's still relevant, adjust emphasis if needed, add new themes if they appear. Stay concise (2-5 sentences). If the new likes are consistent with the existing summary, only make minor refinements.

Updated summary:""",
                        ),
                    ),
                    baseDelayMs = retryBaseDelayMs,
                ).trim()
            } else {
                chatCompletionWithRetry(
                    llm,
                    listOf(
                        ChatMessage("system", Learner.SYSTEM_PROMPT),
                        ChatMessage(
                            "user",
                            """Analyze these Nostr posts that a user has liked/reacted positively to. Based on these posts, summarize the user's interests, preferences, and the types of content they engage with.

Be specific about:
- Topics they care about
- Tone and style they prefer (philosophical, technical, casual, etc.)
- Types of content (longform, short thoughts, links, media, etc.)
- Any recurring themes

Write 2-4 concise sentences. Do not list the posts back. Just describe the user's taste.

Liked posts:
$likesList

Summary:""",
                        ),
                    ),
                    baseDelayMs = retryBaseDelayMs,
                ).trim()
            }
            log.info("  Batch ${b + 1}/${batches.size} done: \"${current.take(80)}...\"")
            // A small pause between batches avoids rate-limit bursts.
            if (b < batches.size - 1 && pauseMs > 0) delay(pauseMs)
        }
        return current ?: ""
    }

    /**
     * Fetch likes newer than the stored watermark and fold them into the learned prompt.
     * Returns the prompt to use, or null when there is none. LLM trouble keeps what was
     * stored, so this never throws for it.
     */
    suspend fun refreshLearnedPrompt(
        fetcher: LikesSource,
        store: PipelineStore,
        llm: LlmConfig,
        pubkeyHex: String,
        log: PipelineLogger = PipelineLogger.silent,
        batchSize: Int = 50,
        now: () -> Long = { System.currentTimeMillis() },
        pauseMs: Long = 1000,
        retryBaseDelayMs: Long = 2000,
    ): String? {
        val cached = store.getLearned()
        var learnedPrompt: String? = null
        if (cached != null) {
            log.info("Loaded existing learned prompt (last updated: ${cached.updatedAt})")
            learnedPrompt = cached.prompt
        }
        val fetchedAt = now() / 1000
        // Catch-up never reaches further back than this: a reader back after months
        // does not pay for their whole history.
        val floor = maxOf(0L, fetchedAt - LEARN_MAX_AGE_SECONDS)
        val sinceTimestamp = cached?.lastLikeTimestamp?.takeIf { it != 0L }?.let { maxOf(floor, it - 300) }
        // The first run reads only the newest page and starts the watermark there.
        val firstRun = sinceTimestamp == null
        val backfillUntil = if (sinceTimestamp != null && cached?.backfillUntil != null && cached.backfillUntil >= sinceTimestamp) cached.backfillUntil else null
        log.info(if (sinceTimestamp != null) "Fetching likes since ${Instant.ofEpochSecond(sinceTimestamp)}..." else "Fetching likes (first run)...")
        val fetched = fetcher.getLikes(pubkeyHex, 200, sinceTimestamp, backfillUntil)
        val processed = cached?.processedReactionIds.orEmpty().toSet()
        val likes = fetched.likes.filter { (it.reactionId ?: it.id) !in processed }
        val fullPage = !firstRun && (fetched.reactionCount ?: fetched.likes.size) >= 200
        val latestReactionTimestamp = (listOf(cached?.latestReactionTimestamp ?: cached?.lastLikeTimestamp ?: 0L) + fetched.likes.map { it.reactedAt ?: fetchedAt }).max()
        val checkpointLast = if (fullPage) cached?.lastLikeTimestamp else latestReactionTimestamp
        val checkpointBackfill = if (fullPage && fetched.nextUntil != null) fetched.nextUntil else null

        if (likes.isEmpty()) {
            if (cached != null && (fullPage || cached.backfillUntil != null)) {
                store.putLearned(cached.copy(backfillUntil = checkpointBackfill, lastLikeTimestamp = checkpointLast, latestReactionTimestamp = latestReactionTimestamp))
            }
            log.info("No new likes since last run, keeping existing learned prompt")
            return learnedPrompt
        }

        log.info("Found ${likes.size} new likes, evolving learned prompt...")
        try {
            val evolved = evolveLearnedPrompt(learnedPrompt, likes.map { it.content }, llm, batchSize, pauseMs, log, retryBaseDelayMs)
            if (evolved.isNotEmpty()) {
                learnedPrompt = evolved
                log.info("Learned prompt: ${evolved.take(100)}...")
                // Never jump over likes created while the model was running: full pages keep
                // the previous watermark until coverage can be checked again.
                store.putLearned(
                    LearnedState(
                        prompt = evolved,
                        updatedAt = Instant.ofEpochMilli(now()).toString(),
                        lastLikeTimestamp = checkpointLast,
                        backfillUntil = checkpointBackfill,
                        latestReactionTimestamp = latestReactionTimestamp,
                        processedReactionIds = (processed.toList() + likes.map { it.reactionId ?: it.id }).takeLast(2000),
                    ),
                )
            } else {
                log.warn("LLM returned empty learned prompt, skipping save")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("failed to evolve learned prompt: ${e.message}")
        }
        return learnedPrompt
    }

    class ScoreCachedInput(
        val context: String? = null,
        val userPrompt: String,
        val learnedPrompt: String? = null,
        val profiles: Map<String, ProfileData>? = null,
        val debug: MutableList<DebugEntry>? = null,
        val modelLabel: String? = null,
        val onProgress: ((Int, Int) -> Unit)? = null,
        /** Awaited before any post is sent to the model, only when some need scoring; the result is called once scoring ends. */
        val beforeScoring: (suspend (Int) -> (() -> Unit)?)? = null,
    )

    /**
     * Score posts, paying only for those the store has not seen. Results keep the order of
     * [posts]; each batch is stored as it lands; fallback scores are returned, never cached.
     */
    suspend fun scorePostsCached(
        ranker: PostScorer,
        store: PipelineStore,
        scorer: ScorerKind,
        posts: List<FetchedPost>,
        input: ScoreCachedInput,
        log: PipelineLogger = PipelineLogger.silent,
    ): List<ScoredPost> {
        fun keyFor(p: FetchedPost) = RankingContext.contextualScoreKey(Scoring.scoreCacheKey(p), input.context)
        val cached = store.getScores(posts.map(::keyFor).distinct())

        val cachedById = HashMap<String, CachedScore>()
        val uncached = mutableListOf<FetchedPost>()
        for (post in posts) {
            val hit = cached[keyFor(post)]
            // The two scorers sit on different scales: a score from the other one would mis-rank.
            if (hit != null && (hit.scorer ?: "chat") == scorer.wire) cachedById[post.id] = hit else uncached.add(post)
        }
        log.info("Scores: ${cachedById.size} cached, ${uncached.size} to score")

        val newById = HashMap<String, ScoredPost>()
        if (uncached.isNotEmpty()) {
            log.info("Scoring ${uncached.size} posts${input.modelLabel?.let { " with $it" } ?: ""} (${scorer.wire} scorer)...")
            val release = input.beforeScoring?.invoke(uncached.size)
            val scored = try {
                coroutineScope {
                    // Each batch is written as it lands, in order, so an interrupted run keeps what it paid for.
                    val writes = Channel<Map<String, CachedScore>>(Channel.UNLIMITED)
                    val writer = launch { for (entries in writes) store.putScores(entries) }
                    try {
                        ranker.score(
                            uncached,
                            ScoreOptions(
                                userPrompt = input.userPrompt,
                                learnedPrompt = input.learnedPrompt,
                                profiles = input.profiles,
                                debug = input.debug,
                                onProgress = { n, total ->
                                    log.info("  Scored $n/$total")
                                    input.onProgress?.invoke(n, total)
                                },
                                onBatchScored = { batch ->
                                    val entries = LinkedHashMap<String, CachedScore>()
                                    for (sp in batch) {
                                        if (!sp.defaultScore) {
                                            entries[keyFor(sp.fetched())] = CachedScore(sp.score, sp.justification, sp.createdAt, if (scorer == ScorerKind.Decision) "decision" else null)
                                        }
                                    }
                                    if (entries.isNotEmpty()) writes.trySend(entries)
                                },
                            ),
                        )
                    } finally {
                        writes.close()
                        withContext(NonCancellable) { writer.join() }
                    }
                }
            } finally {
                release?.invoke()
            }
            for (sp in scored) newById[sp.id] = sp
            val real = scored.count { !it.defaultScore }
            log.info("Scoring done: $real scored by LLM, ${scored.size - real} got default score")
        }

        val all = posts.map { post ->
            newById[post.id] ?: cachedById[post.id]?.let { post.scored(it.score, it.justification) }
                // Should not happen; keep the post rather than drop it.
                ?: post.scored(5.0, null, defaultScore = true)
        }
        store.flush()
        return all
    }

    data class DigestModel(val llm: LlmConfig, val temperature: Double? = null)

    /**
     * Write the digest, falling back to a second model if the first fails, then optionally
     * humanize it. Throws only when every digest model has failed.
     */
    suspend fun writeDigest(
        primary: DigestModel,
        digest: DigestWriter.Options,
        fallback: DigestModel? = null,
        humanizer: Pair<DigestModel, HumanizerSkill>? = null,
        log: PipelineLogger = PipelineLogger.silent,
        retryBaseDelayMs: Long = 2000,
    ): String {
        val messages = DigestWriter.buildDigestMessages(digest)
        var text = try {
            log.info("Generating digest with ${primary.llm.model}...")
            chatCompletionWithRetry(primary.llm, messages, false, 3, retryBaseDelayMs, primary.temperature ?: 0.3)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (fallback == null) throw e
            log.warn("Primary digest model failed (${e.message}), falling back to ${fallback.llm.model}...")
            chatCompletionWithRetry(fallback.llm, messages, false, 3, retryBaseDelayMs, fallback.temperature ?: 0.3)
        }
        if (humanizer != null) {
            val (model, skill) = humanizer
            log.info("Humanizing with ${model.llm.model}...")
            val before = text.length
            text = Humanizer.humanizeText(model.llm, skill, text, forSpeech = true, temperature = model.temperature, baseDelayMs = retryBaseDelayMs, onWarning = log::warn)
            log.info("Humanizer pass: $before chars in, ${text.length} out")
        }
        return text
    }
}
