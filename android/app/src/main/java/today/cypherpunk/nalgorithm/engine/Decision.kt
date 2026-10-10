package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.io.InterruptedIOException

/**
 * Client for typed-decision endpoints (Venice `/decisions`, lib decision.ts).
 * A decision model returns probability distributions, not text. The endpoint is
 * rate-limited per key and locks a key out after many failures, so requests are
 * paced client-side and retried little.
 */
object Decision {
    private const val DEFAULT_TIMEOUT_MS = 60_000L

    /** Venice allows 100/min; stay under it so a concurrent caller has headroom. */
    const val DEFAULT_REQUESTS_PER_MINUTE = 90

    data class ScoreQuestion(val instructions: String, val criteria: List<String>)

    data class ScoreAnswer(val score: Double?, val probabilities: Map<String, Double>)

    data class Request(val state: String, val questions: Map<String, ScoreQuestion>)

    data class Response(val answers: Map<String, ScoreAnswer>, val raw: String)

    /** A refused decision call; [status] lets the ranker tell a bad key from one odd batch. */
    class ApiError(override val status: Int, message: String, val retryAfterMs: Long?) : Exception(message), HasStatus

    /**
     * Spaces request starts at least `60s / rpm` apart. Even spacing never trips the
     * per-minute window, which matters more here than latency.
     */
    fun createPacer(requestsPerMinute: Int = DEFAULT_REQUESTS_PER_MINUTE): suspend () -> Unit {
        val interval = 60_000.0 / maxOf(1, requestsPerMinute)
        var next = 0.0
        val lock = Any()
        return {
            val wait = synchronized(lock) {
                val now = System.currentTimeMillis().toDouble()
                val slot = maxOf(now, next)
                next = slot + interval
                (slot - now).toLong()
            }
            if (wait > 0) delay(wait)
        }
    }

    internal fun requestJson(model: String, request: Request): String = buildJsonObject {
        put("model", model)
        put("state", request.state)
        put(
            "questions",
            JsonObject(
                request.questions.mapValues { (_, q) ->
                    buildJsonObject {
                        put("type", "score")
                        put("instructions", q.instructions)
                        put("criteria", JsonArray(q.criteria.map { JsonPrimitive(it) }))
                    }
                },
            ),
        )
    }.toString()

    private suspend fun completionRaw(config: LlmConfig, request: Request): Response {
        val url = "${config.apiBaseUrl}/decisions"
        val timeoutMs = config.timeoutMs ?: DEFAULT_TIMEOUT_MS
        val headers = mapOf("Content-Type" to "application/json", "Authorization" to "Bearer ${config.apiKey}")
        val text = try {
            config.http.withCallTimeout(timeoutMs).run(jsonPost(url, requestJson(config.model, request), headers)) { res ->
                if (!res.isSuccessful) {
                    val errorBody = res.body.string()
                    val retryAfter = res.header("retry-after")?.toDoubleOrNull()
                    throw ApiError(
                        res.code,
                        "Decision API error (${res.code}): ${errorBody.take(500)}",
                        retryAfter?.takeIf { it > 0 }?.let { (it * 1000).toLong() },
                    )
                }
                res.body.string()
            }
        } catch (e: InterruptedIOException) {
            currentCoroutineContext().ensureActive()
            throw Exception("Decision API timed out after ${timeoutMs}ms")
        }
        val answers = ((Js.parse(text) as? JsonObject)?.get("answers") as? JsonObject)
            ?: throw Exception("Decision API returned no answers")
        return Response(
            answers.mapNotNull { (key, value) ->
                val obj = value as? JsonObject ?: return@mapNotNull null
                val score = (obj["score"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
                val probs = (obj["probabilities"] as? JsonObject)?.mapNotNull { (k, v) ->
                    (v as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.let { k to it }
                }?.toMap().orEmpty()
                key to ScoreAnswer(score, probs)
            }.toMap(),
            text,
        )
    }

    suspend fun completion(config: LlmConfig, request: Request): Response =
        withProviderSlot(config) { completionRaw(config, request) }

    /**
     * [completion] with pacing and a short retry. Only 429s, 5xx and network errors
     * are retried: a 400 means the request shape was refused.
     */
    suspend fun completionWithRetry(config: LlmConfig, request: Request, pace: suspend () -> Unit, maxAttempts: Int = 3): Response {
        var lastErr: Exception? = null
        for (attempt in 1..maxAttempts) {
            currentCoroutineContext().ensureActive()
            pace()
            try {
                return completion(config, request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastErr = e
                val status = (e as? HasStatus)?.status
                val retryable = e !is ProviderBusy && (status == null || status == 429 || status >= 500)
                if (!retryable || attempt == maxAttempts) break
                // A 429 means someone else spends the same key's budget: wait out a real part of the window.
                val wait = (e as? ApiError)?.retryAfterMs ?: if (status == 429) 15_000L * attempt else 2000L * attempt
                delay(wait)
            }
        }
        throw lastErr ?: Exception("Decision call failed")
    }
}
