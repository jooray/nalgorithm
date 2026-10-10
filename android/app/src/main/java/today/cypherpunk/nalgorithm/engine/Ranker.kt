package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Scores posts for relevance (lib ranker.ts), with a chat scorer (numbered batch,
 * tolerant JSON parsing, justifications) or a decision scorer (rubric, distribution).
 */
object Scoring {
    const val DEFAULT_BATCH_SIZE = 20
    const val DEFAULT_SCORE = 5.0
    const val DEFAULT_CONCURRENCY = 1

    /**
     * The identity a post is scored and cached under: for a plain repost the boosted
     * event's id, so ten boosts of one note cost one call; a quote keeps its own id.
     */
    fun scoreCacheKey(id: String, type: PostType, originalId: String?): String =
        if (type == PostType.Boost && !originalId.isNullOrEmpty()) originalId else id

    fun scoreCacheKey(p: FetchedPost) = scoreCacheKey(p.id, p.type, p.originalPost?.id)
    fun scoreCacheKey(p: ScoredPost) = scoreCacheKey(p.id, p.type, p.originalPost?.id)

    /** By relevance (descending), real scores before fallback ones, then newest first. */
    fun sortByRelevance(posts: List<ScoredPost>): List<ScoredPost> = posts.sortedWith { a, b ->
        when {
            a.defaultScore != b.defaultScore -> if (a.defaultScore) 1 else -1
            b.score != a.score -> b.score.compareTo(a.score)
            else -> b.createdAt.compareTo(a.createdAt)
        }
    }

    /** A neutral placeholder: a key prefix would end up in the justifications shown to the reader. */
    private fun resolveAuthorName(pubkey: String, profiles: Map<String, ProfileData>?): String =
        profiles?.get(pubkey)?.name?.takeIf { it.isNotEmpty() } ?: "an unknown author"

    private val NOSTR_REF = Regex("nostr:n(event|ote|pub|profile|addr)1[a-z0-9]+", RegexOption.IGNORE_CASE)

    internal fun stripNostrRefs(content: String): String = content.replace(NOSTR_REF, "[referenced post]").trim()

    internal fun truncate(text: String, maxLen: Int): String {
        val clean = text.replace(Regex("\n+"), " ").trim()
        return if (clean.length <= maxLen) clean else clean.substring(0, maxLen) + "..."
    }

    /** One post for the scoring prompt, with a 1-based number instead of the hex id. */
    internal fun formatPostForPrompt(post: FetchedPost, index: Int, profiles: Map<String, ProfileData>?): String {
        val num = index + 1
        val original = post.originalPost
        if (post.type == PostType.Boost && original != null) {
            val boosterName = resolveAuthorName(post.author, profiles)
            return "$num. [Boosted by $boosterName] \"${truncate(stripNostrRefs(original.content), 500)}\""
        }
        val quoted = post.quotedPost
        if (post.type == PostType.Quote && quoted != null) {
            val quoterName = resolveAuthorName(post.author, profiles)
            return "$num. [Quote by $quoterName] \"${truncate(stripNostrRefs(post.content), 300)}\" — Quoted post: \"${truncate(stripNostrRefs(quoted.content), 300)}\""
        }
        return "$num. \"${truncate(stripNostrRefs(post.content), 500)}\""
    }

    val SYSTEM_PROMPT = """You are a Nostr post relevance scorer. You receive a user's interest profile and a batch of numbered posts. You score each post for personal relevance to that user.

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
- A post matching multiple user interests scores higher than one matching a single interest."""

    internal fun buildUserPrompt(posts: List<FetchedPost>, userPrompt: String, learnedPrompt: String?, profiles: Map<String, ProfileData>?): String {
        val parts = mutableListOf<String>()
        parts.add(
            """Score each post below from 0 to 10 based on how relevant it is to this user's interests and preferences.

Scoring scale:
- 9-10: Directly about a core interest, substantive, high signal. The user would actively seek this out.
- 7-8: Clearly relevant to a listed interest, reasonable depth or insight.
- 5-6: Tangentially related to user interests, or generic content that isn't off-topic.
- 3-4: Mostly irrelevant but not objectionable. Weak or indirect connection at best.
- 1-2: Off-topic, low-effort, or noise. No meaningful connection to the user's interests.
- 0: Spam, completely irrelevant, or content the user explicitly wants filtered out.""",
        )
        parts.add("")
        parts.add("=== User Profile ===")
        parts.add(userPrompt)
        if (!learnedPrompt.isNullOrBlank()) {
            parts.add("")
            parts.add("=== Learned Preferences (from user behavior) ===")
            parts.add(learnedPrompt)
        }
        parts.add("")
        parts.add("=== Posts to Score ===")
        posts.forEachIndexed { i, post -> parts.add(formatPostForPrompt(post, i, profiles)) }
        parts.add("")
        parts.add("Score all ${posts.size} posts. Respond with JSON only.")
        return parts.joinToString("\n")
    }

    // ─── Response parsing ────────────────────────────────────────────────────

    private val INDEX_KEYS = listOf("post_number", "postNumber", "post", "index", "idx", "number", "n", "id")
    private val SCORE_KEYS = listOf("score", "relevance", "rating", "value")
    private val REASON_KEYS = listOf("justification", "reason", "explanation", "why", "rationale")

    /** Reasoning models sometimes leak their think block into the content, even inside the JSON. */
    internal fun stripThinkBlocks(raw: String): String = raw
        .replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "")
        .replace(Regex("</?think>", RegexOption.IGNORE_CASE), "")
        .trim()

    private fun pick(obj: JsonObject, keys: List<String>): JsonElement? {
        for (k in keys) {
            val v = obj[k]
            if (v != null && v !is JsonNull) return v
        }
        return null
    }

    private fun toNumber(value: JsonElement?): Double? {
        val p = value as? JsonPrimitive ?: return null
        if (!p.isString) return p.doubleOrNull?.takeIf { !it.isNaN() }
        return Js.parseInt(p.content)?.toDouble()
    }

    /** One coerced entry: (1-based index, score clamped to 0..10, justification). */
    internal data class Entry(val index: Double, val score: Double, val justification: String)

    internal data class Candidate(val item: JsonElement, val fallbackIndex: Int?)

    /** Accepts the tuple form, two-element forms and the object form models drift into. */
    internal fun coerceEntry(item: JsonElement, fallbackIndex: Int?): Entry? {
        var idxRaw: JsonElement? = null
        val scoreRaw: JsonElement?
        var reasonRaw: JsonElement? = null
        when {
            item is JsonArray -> when {
                item.size >= 3 -> { idxRaw = item[0]; scoreRaw = item[1]; reasonRaw = item[2] }
                item.size == 2 -> {
                    val second = item[1]
                    if (second is JsonPrimitive && second.isString) { scoreRaw = item[0]; reasonRaw = second } else { idxRaw = item[0]; scoreRaw = second }
                }
                else -> return null
            }
            item is JsonObject -> {
                idxRaw = pick(item, INDEX_KEYS)
                scoreRaw = pick(item, SCORE_KEYS)
                reasonRaw = pick(item, REASON_KEYS)
            }
            item is JsonPrimitive && !item.isString && item.doubleOrNull != null -> scoreRaw = item
            else -> return null
        }
        val score = toNumber(scoreRaw) ?: return null
        val idx = toNumber(idxRaw) ?: fallbackIndex?.toDouble() ?: return null
        val reason = (reasonRaw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        return Entry(idx, score.coerceIn(0.0, 10.0), reason)
    }

    /** A bare array; an object wrapping the array under any key; or an object keyed by post number. */
    internal fun toEntryList(parsed: JsonElement): List<Candidate> {
        if (parsed is JsonArray) return parsed.mapIndexed { i, item -> Candidate(item, i + 1) }
        if (parsed is JsonObject) {
            val entries = parsed.entries.toList()
            // Checked first: {"1": [1, 9, "…"]} is numeric-keyed *and* holds arrays.
            if (entries.isNotEmpty() && entries.all { (k, _) -> Regex("^\\d+$").matches(k) }) {
                return entries.map { (k, v) -> Candidate(v, k.toLongOrNull()?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt() ?: Int.MAX_VALUE) }
            }
            val arrays = entries.map { it.value }.filterIsInstance<JsonArray>()
            val structured = arrays.firstOrNull { arr -> arr.any { it is JsonArray || it is JsonObject } }
            val chosen = structured ?: arrays.firstOrNull()
            if (chosen != null) return chosen.mapIndexed { i, item -> Candidate(item, i + 1) }
        }
        return emptyList()
    }

    private val TUPLE = Regex("\\[\\s*(\\d+)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:,\\s*(\"(?:[^\"\\\\]|\\\\.)*\"))?\\s*]")
    private val OBJECT = Regex("\\{[^{}]*}")

    /** Whole entries out of text that does not parse (usually a truncated response). */
    internal fun salvageEntries(text: String): List<Candidate> {
        val out = mutableListOf<Candidate>()
        for (m in TUPLE.findAll(text)) {
            val reason = m.groups[3]?.value?.let { (Js.parse(it) as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: ""
            out.add(
                Candidate(
                    JsonArray(listOf(JsonPrimitive(m.groupValues[1].toBigDecimal()), JsonPrimitive(m.groupValues[2].toBigDecimal()), JsonPrimitive(reason))),
                    null,
                ),
            )
        }
        if (out.isNotEmpty()) return out
        for (m in OBJECT.findAll(text)) {
            Js.parse(m.value)?.let { out.add(Candidate(it, null)) }
        }
        return out
    }

    internal data class Validated(val scores: List<Entry>, val error: String?)

    /**
     * The documented contract is an array of [post_number, score, justification], but models
     * drift. Rather than defaulting a whole batch over a cosmetic difference, accept the common
     * variants and report what had to be coerced.
     */
    internal fun validateScoreResponse(raw: String, postCount: Int): Validated {
        val cleaned = stripThinkBlocks(raw)
        val candidates = mutableListOf<String>()
        Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(cleaned)?.let { candidates.add(it.groupValues[1].trim()) }
        candidates.add(cleaned)
        Regex("(\\[[\\s\\S]*])").find(cleaned)?.let { candidates.add(it.groupValues[1]) }
        Regex("(\\{[\\s\\S]*})").find(cleaned)?.let { candidates.add(it.groupValues[1]) }

        var entries: List<Candidate> = emptyList()
        var parseFailed = true
        for (candidate in candidates) {
            val parsed = Js.parse(candidate) ?: continue
            parseFailed = false
            val found = toEntryList(parsed)
            if (found.isNotEmpty()) {
                entries = found
                break
            }
        }

        var salvaged = false
        if (entries.isEmpty()) {
            val found = salvageEntries(cleaned)
            if (found.isNotEmpty()) {
                entries = found
                salvaged = true
            }
        }

        if (entries.isEmpty()) {
            return Validated(
                emptyList(),
                if (parseFailed) "Failed to parse LLM response as JSON" else "LLM response contained no recognizable score entries",
            )
        }

        val results = mutableListOf<Entry>()
        val errors = mutableListOf<String>()
        for ((item, fallbackIndex) in entries) {
            val coerced = coerceEntry(item, fallbackIndex)
            if (coerced == null) {
                errors.add("Unrecognized entry: ${Js.stringify(item).take(120)}")
                continue
            }
            if (coerced.index < 1 || coerced.index > postCount) {
                errors.add("Index out of range: ${Js.number(coerced.index)} (expected 1-$postCount)")
                continue
            }
            results.add(coerced)
        }
        if (results.isEmpty()) return Validated(emptyList(), "No valid scores parsed. Errors: ${errors.joinToString("; ")}")

        val notes = mutableListOf<String>()
        if (salvaged) notes.add("Salvaged ${results.size} entries from unparseable output (likely truncated)")
        if (errors.isNotEmpty()) notes.add("Partial parse (${results.size}/${entries.size}): ${errors.joinToString("; ")}")
        return Validated(results, if (notes.isEmpty()) null else notes.joinToString(". "))
    }

    // ─── Decision-model scoring ─────────────────────────────────────────────

    /** The rubric a decision model scores against, lowest level first. Level i maps to i * 2. */
    val DECISION_RUBRIC = listOf(
        "Spam, completely irrelevant, or content the user explicitly wants filtered out.",
        "Off-topic, low-effort, or noise (greetings, bare images, memes). No meaningful connection to the user's interests.",
        "Mostly irrelevant but not objectionable. Weak or indirect connection at best.",
        "Tangentially related to the user's interests, or generic content that is not off-topic.",
        "Clearly relevant to one of the user's interests, with reasonable depth or insight.",
        "Directly about a core interest of the user, substantive, high signal. The user would actively seek this out.",
    )
    private val DECISION_MAX_LEVEL = DECISION_RUBRIC.size - 1

    /** The same text the chat scorer sees, without its "1. " prefix. */
    private fun formatPostForDecision(post: FetchedPost, profiles: Map<String, ProfileData>?): String =
        formatPostForPrompt(post, 0, profiles).replaceFirst(Regex("^1\\. "), "")

    private fun buildUserDescription(userPrompt: String, learnedPrompt: String?): String {
        val parts = mutableListOf("=== User Profile ===", userPrompt.trim())
        if (!learnedPrompt.isNullOrBlank()) {
            parts.addAll(listOf("", "=== Learned Preferences (from posts the user liked) ===", learnedPrompt.trim()))
        }
        return parts.joinToString("\n")
    }

    private const val DECISION_MECHANICS = "Score a boosted post by the original content being boosted. Score a quote post by the quote and the quoted post together. Short low-effort posts (greetings, a single emoji, a bare link or image) score low unless the user's profile explicitly values them. A post matching several of the user's interests scores higher than one matching a single interest. Anything the user says they do not care about or want filtered out scores at the bottom, however well made it is."

    /** One decision request for a batch: every post gets its own question, so posts never share a state. */
    fun buildDecisionRequest(
        posts: List<FetchedPost>,
        userPrompt: String,
        learnedPrompt: String?,
        shape: DecisionShape,
        profiles: Map<String, ProfileData>? = null,
    ): Decision.Request {
        val user = buildUserDescription(userPrompt, learnedPrompt)
        val questions = LinkedHashMap<String, Decision.ScoreQuestion>()
        posts.forEachIndexed { i, post ->
            val postText = formatPostForDecision(post, profiles)
            val instructions = if (shape == DecisionShape.ProfileInQuestion) {
                "How relevant is the Nostr post below to this user's interests and preferences?\n\n$user\n\n$DECISION_MECHANICS\n\n=== Post ===\n$postText"
            } else {
                "How relevant is the Nostr post below to the interests and preferences of the user described in the state? $DECISION_MECHANICS\n\n=== Post ===\n$postText"
            }
            questions["p${i + 1}"] = Decision.ScoreQuestion(instructions, DECISION_RUBRIC)
        }
        val state = if (shape == DecisionShape.ProfileInQuestion) {
            "Relevance scoring of Nostr posts for one user. Everything needed is in each question."
        } else {
            user
        }
        return Decision.Request(state, questions)
    }

    /** "74% clearly relevant…; 20% directly about…": the distribution as a reason. */
    internal fun describeDistribution(probabilities: Map<String, Double>): String = probabilities.entries
        .map { (level, p) -> (level.toDoubleOrNull() ?: Double.NaN) to p }
        .filter { (_, p) -> p >= 0.15 }
        .sortedByDescending { it.second }
        .take(2)
        .joinToString("; ") { (level, p) ->
            val text = level.takeIf { it == Math.rint(it) }?.toInt()?.let { DECISION_RUBRIC.getOrNull(it) }
                ?.split('.')?.first()?.lowercase() ?: "level ${Js.number(level)}"
            "${Js.round(p * 100)}% $text"
        }

    /**
     * Errors no other batch can get past: a bad key, an unknown model, a full provider queue.
     * A 400 or 413 belongs to one batch, so it costs that batch its scores, not the run.
     */
    internal fun failsEveryBatch(err: Throwable): Boolean {
        val status = (err as? HasStatus)?.status
        return err is ProviderBusy || status == 401 || status == 403 || status == 404
    }

    internal fun decisionScore(answer: Double): Double {
        val level = answer.coerceIn(0.0, DECISION_MAX_LEVEL.toDouble())
        // Two decimals: coarser rounding recreates the ties at the top-N cutoff that a
        // continuous score is meant to remove.
        return Js.round((level / DECISION_MAX_LEVEL) * 1000) / 100.0
    }
}

data class RankerConfig(
    val llm: LlmConfig,
    val batchSize: Int = Scoring.DEFAULT_BATCH_SIZE,
    val concurrency: Int = Scoring.DEFAULT_CONCURRENCY,
    /** Off by default: JSON mode pulls models toward wrapper objects and breaks reasoning models. */
    val jsonMode: Boolean = false,
    val scorer: ScorerKind = ScorerKind.Chat,
    val decisionShape: DecisionShape = DecisionShape.ProfileInQuestion,
    val requestsPerMinute: Int = Decision.DEFAULT_REQUESTS_PER_MINUTE,
)

class ScoreOptions(
    val userPrompt: String,
    val learnedPrompt: String? = null,
    val profiles: Map<String, ProfileData>? = null,
    val debug: MutableList<DebugEntry>? = null,
    /** After each batch: (scored so far, total). */
    val onProgress: ((Int, Int) -> Unit)? = null,
    /** Each batch's results as soon as it lands, so a cache keeps what was paid for. */
    val onBatchScored: ((List<ScoredPost>) -> Unit)? = null,
)

/** What scores posts; [Ranker] is the real one, tests use fakes. */
fun interface PostScorer {
    suspend fun score(posts: List<FetchedPost>, options: ScoreOptions): List<ScoredPost>
}

class Ranker(private val config: RankerConfig) : PostScorer {
    private val batchSize = config.batchSize
    private val concurrency = maxOf(1, config.concurrency)
    private val pace = Decision.createPacer(config.requestsPerMinute)

    init {
        require(batchSize in 1..100) { "Scoring batch size must be a whole number from 1 to 100." }
        require(concurrency <= 20) { "Scoring concurrency must be a whole number from 1 to 20." }
    }

    private data class BatchScore(val score: Double, val justification: String, val defaultScore: Boolean = false)

    private suspend fun scoreBatchDecision(posts: List<FetchedPost>, options: ScoreOptions, batchIndex: Int): Map<String, BatchScore> {
        val scoreMap = LinkedHashMap<String, BatchScore>()
        var rawResponse: String? = null
        var debugError: String? = null
        try {
            val request = Scoring.buildDecisionRequest(posts, options.userPrompt, options.learnedPrompt, config.decisionShape, options.profiles)
            val response = Decision.completionWithRetry(config.llm, request, pace)
            rawResponse = response.raw
            posts.forEachIndexed { i, post ->
                val answer = response.answers["p${i + 1}"] ?: return@forEachIndexed
                val score = answer.score?.takeIf { !it.isNaN() } ?: return@forEachIndexed
                scoreMap[post.id] = BatchScore(Scoring.decisionScore(score), Scoring.describeDistribution(answer.probabilities))
            }
            if (scoreMap.size < posts.size) debugError = "Decision response answered ${scoreMap.size}/${posts.size} questions"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (Scoring.failsEveryBatch(e)) throw e
            debugError = "Decision call failed: ${e.message}"
        }
        options.debug?.add(DebugEntry(batchIndex, rawResponse, debugError, posts.size, scoreMap.size))
        for (post in posts) if (post.id !in scoreMap) scoreMap[post.id] = BatchScore(Scoring.DEFAULT_SCORE, "", defaultScore = true)
        return scoreMap
    }

    private suspend fun scoreBatchChat(posts: List<FetchedPost>, options: ScoreOptions, batchIndex: Int): Map<String, BatchScore> {
        val userMsg = Scoring.buildUserPrompt(posts, options.userPrompt, options.learnedPrompt, options.profiles)
        val scoreMap = LinkedHashMap<String, BatchScore>()
        var rawResponse: String? = null
        var debugError: String? = null
        try {
            rawResponse = chatCompletionWithRetry(
                config.llm,
                listOf(ChatMessage("system", Scoring.SYSTEM_PROMPT), ChatMessage("user", userMsg)),
                config.jsonMode,
            )
            val result = Scoring.validateScoreResponse(rawResponse, posts.size)
            if (result.scores.isNotEmpty()) {
                for (e in result.scores) {
                    // 1-based; a fractional index names no post.
                    if (e.index != Math.rint(e.index)) continue
                    val post = posts.getOrNull(e.index.toInt() - 1) ?: continue
                    scoreMap[post.id] = BatchScore(e.score, e.justification)
                }
                if (result.error != null) debugError = result.error
            } else {
                debugError = result.error ?: "Validation returned no scores"
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (Scoring.failsEveryBatch(e)) throw e
            debugError = "LLM call failed: ${e.message}"
        }
        options.debug?.add(DebugEntry(batchIndex, rawResponse, debugError, posts.size, scoreMap.size))
        for (post in posts) if (post.id !in scoreMap) scoreMap[post.id] = BatchScore(Scoring.DEFAULT_SCORE, "", defaultScore = true)
        return scoreMap
    }

    override suspend fun score(posts: List<FetchedPost>, options: ScoreOptions): List<ScoredPost> {
        if (posts.isEmpty()) return emptyList()

        // Group by scoring identity, so a note boosted ten times is scored once.
        val groups = LinkedHashMap<String, MutableList<FetchedPost>>()
        for (post in posts) groups.getOrPut(Scoring.scoreCacheKey(post)) { mutableListOf() }.add(post)

        // A non-boost carries the real author and full event, so it represents the group.
        val representatives = groups.values.map { group -> group.firstOrNull { it.type != PostType.Boost } ?: group[0] }
        val batches = representatives.chunked(batchSize)
        val allScores = ConcurrentHashMap<String, BatchScore>()

        // Progress counts the work done, not the post count: with boosts collapsed they differ.
        var scoredSoFar = 0
        val total = representatives.size
        val nextBatch = AtomicInteger(0)
        val emit = Mutex()

        // A worker pool: each worker takes the next batch the moment it finishes one, so
        // `concurrency` requests stay in flight instead of waiting on the slowest of a window.
        coroutineScope {
            repeat(minOf(concurrency, batches.size)) {
                launch {
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val index = nextBatch.getAndIncrement()
                        if (index >= batches.size) return@launch
                        val batch = batches[index]
                        val batchScores = if (config.scorer == ScorerKind.Decision) {
                            scoreBatchDecision(batch, options, index)
                        } else {
                            scoreBatchChat(batch, options, index)
                        }
                        for (rep in batch) batchScores[rep.id]?.let { allScores[Scoring.scoreCacheKey(rep)] = it }
                        emit.withLock {
                            options.onBatchScored?.let { callback ->
                                val emitted = mutableListOf<ScoredPost>()
                                for (rep in batch) {
                                    val data = batchScores[rep.id]
                                    for (post in groups[Scoring.scoreCacheKey(rep)] ?: listOf(rep)) {
                                        emitted.add(post.scored(data?.score ?: Scoring.DEFAULT_SCORE, data?.justification, data?.defaultScore == true))
                                    }
                                }
                                callback(emitted)
                            }
                            scoredSoFar += batch.size
                            options.onProgress?.invoke(scoredSoFar, total)
                        }
                    }
                }
            }
        }

        val scored = posts.map { post ->
            val data = allScores[Scoring.scoreCacheKey(post)]
            post.scored(data?.score ?: Scoring.DEFAULT_SCORE, data?.justification, data?.defaultScore == true)
        }
        return Scoring.sortByRelevance(scored)
    }
}
