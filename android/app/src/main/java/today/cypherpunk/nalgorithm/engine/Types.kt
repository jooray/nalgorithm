package today.cypherpunk.nalgorithm.engine

import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.util.concurrent.TimeUnit

/**
 * The ranking library (lib/src) in Kotlin. Types follow lib/src/types.ts; the
 * shapes the rest of the app shares (ScoredPost, ProfileData…) come from model/.
 */

/** A post as fetched, before scoring (lib FetchedPost). */
data class FetchedPost(
    val id: String,
    val type: PostType,
    /** Pubkey of the follow who posted, boosted or quoted. */
    val author: String,
    val content: String,
    val createdAt: Long,
    val quotedPost: EmbeddedPost? = null,
    val originalPost: EmbeddedPost? = null,
    val rawEvent: NostrEvent? = null,
)

fun FetchedPost.scored(score: Double, justification: String? = null, defaultScore: Boolean = false): ScoredPost = ScoredPost(
    id = id, type = type, author = author, content = content, createdAt = createdAt,
    quotedPost = quotedPost, originalPost = originalPost,
    score = score, justification = justification?.takeIf { it.isNotEmpty() }, defaultScore = defaultScore,
    rawEvent = rawEvent,
)

fun ScoredPost.fetched(): FetchedPost = FetchedPost(id, type, author, content, createdAt, quotedPost, originalPost, rawEvent)

data class LikedPostContent(
    val id: String,
    val content: String,
    val author: String,
    val reactionId: String? = null,
    val reactedAt: Long? = null,
)

/** lib FetchLikesResult: the likes plus the paging facts of the reactions behind them. */
data class LikesPage(
    val likes: List<LikedPostContent>,
    val reactionCount: Int? = null,
    val nextUntil: Long? = null,
)

data class DebugEntry(
    val batch: Int,
    val rawResponse: String?,
    val error: String?,
    val postCount: Int,
    val scoredCount: Int,
)

@Serializable
data class ChatMessage(val role: String, val content: String)

enum class ScorerKind(val wire: String) {
    Chat("chat"), Decision("decision");

    companion object {
        fun of(value: String?): ScorerKind = if (value == "decision") Decision else Chat
    }
}

enum class DecisionShape { ProfileInQuestion, ProfileInState }

/**
 * One OpenAI-compatible endpoint and model (lib LLMConfig). [http] is the
 * client calls go through; per-call timeouts are derived from it.
 */
data class LlmConfig(
    val apiBaseUrl: String,
    val apiKey: String,
    val model: String,
    /** Sent as `reasoning_effort` only when set. */
    val reasoningEffort: String? = null,
    val timeoutMs: Long? = null,
    val http: OkHttpClient = EngineHttp.default,
)

object EngineHttp {
    /** Used when a caller does not hand in the app's client (tests, tools). */
    val default: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).build()
    }
}
