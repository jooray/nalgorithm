package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

/** An HTTP status from a provider that callers branch on (lib: the `status` on an Error). */
interface HasStatus {
    val status: Int
}

/** lib llm.ts ProviderError: a provider answered with an error status. */
class ProviderError(override val status: Int, message: String, val retryAfterMs: Long = 0) : Exception(message), HasStatus {
    val retryable: Boolean get() = status == 429 || status >= 500
}

/** Fail a stalled request rather than hanging a run forever. */
private const val DEFAULT_TIMEOUT_MS = 120_000L
private val JSON_TYPE = "application/json".toMediaType()

fun providerHeaders(apiKey: String): Map<String, String> = buildMap {
    put("Content-Type", "application/json")
    if (apiKey.trim().isNotEmpty()) put("Authorization", "Bearer $apiKey")
}

internal fun retryAfterMs(header: String?): Long {
    val seconds = header?.trim()?.let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() } ?: 0.0
    return (seconds * 1000).toLong().coerceIn(0, 60_000)
}

internal fun responseError(res: Response): ProviderError {
    val s = res.code
    val hint = when {
        s == 401 || s == 403 -> "Check your model API key and permissions."
        s == 400 || s == 404 -> "Check the model name and API endpoint."
        s == 429 -> "The model provider is rate-limiting requests."
        else -> "The model provider is temporarily unavailable."
    }
    return ProviderError(s, "Model request failed ($s). $hint", retryAfterMs(res.header("retry-after")))
}

internal fun jsonPost(url: String, body: String, headers: Map<String, String>): Request =
    Request.Builder().url(url).post(body.toRequestBody(JSON_TYPE)).apply {
        for ((k, v) in headers) if (k != "Content-Type") header(k, v)
    }.build()

/**
 * Run one call on the IO pool. Cancelling the caller cancels the HTTP call, so a
 * reader who leaves never keeps paying for a request nobody waits on.
 */
internal suspend fun <T> OkHttpClient.run(request: Request, block: (Response) -> T): T = coroutineScope {
    val call = newCall(request)
    val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            call.cancel()
        }
    }
    try {
        withContext(Dispatchers.IO) { call.execute().use(block) }
    } finally {
        watcher.cancel()
    }
}

/** A client whose whole call (connect, headers, body) must finish within [ms]. */
internal fun OkHttpClient.withCallTimeout(ms: Long): OkHttpClient =
    newBuilder().callTimeout(ms, TimeUnit.MILLISECONDS).readTimeout(ms, TimeUnit.MILLISECONDS).build()

private fun messagesJson(messages: List<ChatMessage>) = JsonArray(
    messages.map { buildJsonObject { put("role", it.role); put("content", it.content) } },
)

private suspend fun chatCompletionRaw(config: LlmConfig, messages: List<ChatMessage>, jsonMode: Boolean, temperature: Double): String {
    val url = "${config.apiBaseUrl}/chat/completions"
    val body = buildJsonObject {
        put("model", config.model)
        put("messages", messagesJson(messages))
        put("temperature", temperature)
        // Only sent when configured: models without reasoning-effort support reject or ignore it.
        config.reasoningEffort?.let { put("reasoning_effort", it) }
        if (jsonMode) put("response_format", buildJsonObject { put("type", "json_object") })
    }
    val timeoutMs = config.timeoutMs ?: DEFAULT_TIMEOUT_MS
    val text = try {
        config.http.withCallTimeout(timeoutMs).run(jsonPost(url, body.toString(), providerHeaders(config.apiKey))) { res ->
            if (!res.isSuccessful) throw responseError(res)
            res.body.string()
        }
    } catch (e: InterruptedIOException) {
        currentCoroutineContext().ensureActive()
        // Surfaced as a normal error so the retry path can handle it.
        throw Exception("LLM API timed out after ${timeoutMs}ms")
    }
    val content = (Js.parse(text) as? JsonObject)?.get("choices")?.let { it as? JsonArray }?.firstOrNull()
        ?.let { it as? JsonObject }?.get("message")?.let { it as? JsonObject }?.get("content")
        ?.let { it as? JsonPrimitive }?.takeIf { it.isString }?.content
    if (content.isNullOrEmpty()) throw Exception("LLM API returned empty response")
    return content
}

/** One chat completion (OpenAI shape) through the provider's shared budget. */
suspend fun chatCompletion(config: LlmConfig, messages: List<ChatMessage>, jsonMode: Boolean = false, temperature: Double = 0.3): String =
    withProviderSlot(config) { chatCompletionRaw(config, messages, jsonMode, temperature) }

private suspend fun chatCompletionStreamRaw(config: LlmConfig, messages: List<ChatMessage>, onDelta: (String) -> Unit, temperature: Double): String {
    val url = "${config.apiBaseUrl}/chat/completions"
    val body = buildJsonObject {
        put("model", config.model)
        put("messages", messagesJson(messages))
        put("temperature", temperature)
        put("stream", true)
        config.reasoningEffort?.let { put("reasoning_effort", it) }
    }
    // For a stream this is an idle timeout, not a total-duration one: it applies to each
    // read. A digest can legitimately run for minutes; what we want to catch is a stall.
    val idleMs = config.timeoutMs ?: DEFAULT_TIMEOUT_MS
    val client = config.http.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .readTimeout(idleMs, TimeUnit.MILLISECONDS)
        .build()
    val full = StringBuilder()
    try {
        client.run(jsonPost(url, body.toString(), providerHeaders(config.apiKey))) { res ->
            if (!res.isSuccessful) throw responseError(res)
            val source = res.body.source()
            // Server-sent events end at a blank line; lines of an event are gathered until then.
            val event = mutableListOf<String>()
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.isNotEmpty()) {
                    event.add(line)
                    continue
                }
                for (l in event) {
                    if (!l.startsWith("data:")) continue
                    val data = l.substring(5).trim()
                    if (data.isEmpty() || data == "[DONE]") continue
                    val piece = try {
                        (Js.parse(data) as? JsonObject)?.get("choices")?.jsonArray?.firstOrNull()?.jsonObject
                            ?.get("delta")?.let { it as? JsonObject }?.get("content")?.jsonPrimitive?.contentOrNull
                    } catch (_: Exception) {
                        // A malformed frame is not worth aborting a good stream over.
                        null
                    }
                    if (!piece.isNullOrEmpty()) {
                        full.append(piece)
                        onDelta(piece)
                    }
                }
                event.clear()
            }
        }
    } catch (e: InterruptedIOException) {
        currentCoroutineContext().ensureActive()
        throw Exception(
            if (full.isNotEmpty()) "LLM stream stalled for ${idleMs}ms after ${full.length} characters"
            else "LLM API sent nothing for ${idleMs}ms",
        )
    }
    if (full.isEmpty()) throw Exception("LLM API returned empty response")
    return full.toString()
}

/**
 * A streaming chat completion: [onDelta] gets each fragment as it arrives, the
 * result is the whole text. Worth it for anything a person waits on.
 */
suspend fun chatCompletionStream(config: LlmConfig, messages: List<ChatMessage>, onDelta: (String) -> Unit, temperature: Double = 0.5): String =
    withProviderSlot(config) { chatCompletionStreamRaw(config, messages, onDelta, temperature) }

/**
 * [chatCompletion] with exponential-backoff retries on network errors, 429 and 5xx.
 * A non-retryable provider answer (bad key, unknown model) or a full queue fails at once.
 */
suspend fun chatCompletionWithRetry(
    config: LlmConfig,
    messages: List<ChatMessage>,
    jsonMode: Boolean = false,
    maxAttempts: Int = 3,
    baseDelayMs: Long = 2000,
    temperature: Double = 0.3,
): String {
    var lastErr: Exception? = null
    for (attempt in 1..maxAttempts) {
        currentCoroutineContext().ensureActive()
        try {
            return chatCompletion(config, messages, jsonMode, temperature)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            lastErr = e
            if ((e is ProviderError && !e.retryable) || e is ProviderBusy) break
            if (attempt < maxAttempts) {
                val wait = if (e is ProviderError && e.retryAfterMs > 0) e.retryAfterMs else baseDelayMs * (1L shl (attempt - 1))
                delay(wait)
            }
        }
    }
    throw lastErr ?: Exception("LLM call failed")
}
