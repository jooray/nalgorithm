package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.InterruptedIOException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * OpenAI-compatible text-to-speech (lib tts.ts). Providers cap one request's input
 * (Venice: 4096 characters) while a digest runs longer, so text is split on natural
 * boundaries and the audio is joined.
 */
object Tts {
    /** Provider-side cap on a single `/audio/speech` request. Venice enforces 4096. */
    const val DEFAULT_MAX_CHARS = 4096

    /** Formats whose byte streams can be concatenated; containers carry per-file headers. */
    private val CONCATENABLE = setOf("mp3", "pcm")

    data class Config(
        val apiBaseUrl: String,
        val apiKey: String,
        val model: String,
        val voice: String? = null,
        val speed: Double? = null,
        /** mp3 (default) is the only one safe to join across chunks, with pcm. */
        val format: String = "mp3",
        val maxChars: Int = DEFAULT_MAX_CHARS,
        val timeoutMs: Long = 180_000,
        val http: okhttp3.OkHttpClient = EngineHttp.default,
    )

    /**
     * Chunks of at most [maxChars], preferring paragraph breaks, then sentence ends, then
     * whitespace, so a seam lands where a short pause sounds intentional.
     */
    fun splitText(text: String, maxChars: Int = DEFAULT_MAX_CHARS): List<String> {
        require(maxChars > 0) { "splitTextForTTS: maxChars must be positive" }
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return emptyList()
        if (trimmed.length <= maxChars) return listOf(trimmed)

        val units = splitKeepingSeparators(trimmed, Regex("\n{2,}"))
        val chunks = mutableListOf<String>()
        var current = StringBuilder()
        fun flush() {
            val value = current.toString().trim()
            if (value.isNotEmpty()) chunks.add(value)
            current = StringBuilder()
        }
        for (unit in units) {
            if (current.length + unit.length <= maxChars) {
                current.append(unit)
                continue
            }
            flush()
            if (unit.trim().length <= maxChars) {
                current.append(unit)
                continue
            }
            // A paragraph alone is oversized: descend to sentences, then words.
            for (piece in splitOversized(unit, maxChars)) {
                if (current.length + piece.length <= maxChars) {
                    current.append(piece)
                } else {
                    flush()
                    current.append(piece)
                }
            }
        }
        flush()
        return chunks
    }

    private fun splitOversized(block: String, maxChars: Int): List<String> {
        val out = mutableListOf<String>()
        for (sentence in splitKeepingSeparators(block, Regex("(?<=[.!?])${Js.WS}+"))) {
            if (sentence.length <= maxChars) {
                out.add(sentence)
                continue
            }
            for (word in splitKeepingSeparators(sentence, Regex("${Js.WS}+"))) {
                if (word.length <= maxChars) {
                    out.add(word)
                    continue
                }
                // A single token longer than the limit (a URL, say): hard cut.
                var i = 0
                while (i < word.length) {
                    out.add(word.substring(i, minOf(word.length, i + maxChars)))
                    i += maxChars
                }
            }
        }
        return out
    }

    /** Split with each separator kept on the piece before it, so joining reproduces the text. */
    internal fun splitKeepingSeparators(text: String, separator: Regex): List<String> {
        val pieces = mutableListOf<String>()
        var last = 0
        for (m in separator.findAll(text)) {
            if (m.value.isEmpty()) continue
            pieces.add(text.substring(last, m.range.last + 1))
            last = m.range.last + 1
        }
        if (last < text.length) pieces.add(text.substring(last))
        return pieces.filter { it.isNotEmpty() }
    }

    /**
     * Strip ID3v2 (leading) and ID3v1 (trailing) tags, so a joined stream has no
     * metadata block partway through, which some decoders play as noise.
     */
    internal fun stripId3(buffer: ByteArray): ByteArray {
        var start = 0
        var end = buffer.size
        fun b(i: Int) = buffer[i].toInt() and 0xff
        if (buffer.size >= 10 && b(0) == 0x49 && b(1) == 0x44 && b(2) == 0x33) {
            val size = ((b(6) and 0x7f) shl 21) or ((b(7) and 0x7f) shl 14) or ((b(8) and 0x7f) shl 7) or (b(9) and 0x7f)
            val hasFooter = (b(5) and 0x10) != 0
            start = minOf(buffer.size, 10 + size + if (hasFooter) 10 else 0)
        }
        if (end - start >= 128 && b(end - 128) == 0x54 && b(end - 127) == 0x41 && b(end - 126) == 0x47) end -= 128
        return if (start == 0 && end == buffer.size) buffer else buffer.copyOfRange(start, end)
    }

    private suspend fun synthesizeChunk(config: Config, text: String): ByteArray {
        val url = "${config.apiBaseUrl}/audio/speech"
        val body = buildJsonObject {
            put("model", config.model)
            put("input", text)
            put("response_format", config.format)
            if (!config.voice.isNullOrEmpty()) put("voice", config.voice)
            config.speed?.let { put("speed", it) }
        }
        return try {
            config.http.withCallTimeout(config.timeoutMs).run(jsonPost(url, body.toString(), providerHeaders(config.apiKey))) { res ->
                if (!res.isSuccessful) throw ProviderError(res.code, "Audio request failed (${res.code}). Check the TTS model, voice and key.")
                res.body.bytes()
            }
        } catch (e: InterruptedIOException) {
            currentCoroutineContext().ensureActive()
            throw Exception("TTS API timed out")
        }
    }

    /**
     * Speak [text], splitting oversized input and joining the audio in text order. Chunks
     * run [concurrency] at a time; one chunk that fails after its retries fails the whole.
     */
    suspend fun synthesize(
        config: Config,
        text: String,
        onProgress: ((Int, Int) -> Unit)? = null,
        maxAttempts: Int = 3,
        baseDelayMs: Long = 2000,
        concurrency: Int = 3,
    ): ByteArray {
        val chunks = splitText(text, config.maxChars)
        if (chunks.isEmpty()) throw Exception("TTS: nothing to synthesize (input was empty)")
        if (chunks.size > 1 && config.format !in CONCATENABLE) {
            throw Exception(
                "TTS: input needs ${chunks.size} chunks (over the ${config.maxChars}-character limit) but format " +
                    "\"${config.format}\" cannot be concatenated safely. Use \"mp3\" (or \"pcm\") for long text, " +
                    "or shorten the digest.",
            )
        }
        val parts = arrayOfNulls<ByteArray>(chunks.size)
        val next = AtomicInteger(0)
        val failure = AtomicReference<Exception?>(null)
        val budget = LlmConfig(config.apiBaseUrl, config.apiKey, config.model)
        coroutineScope {
            repeat(concurrency.coerceIn(1, chunks.size)) {
                launch {
                    while (failure.get() == null) {
                        val i = next.getAndIncrement()
                        if (i >= chunks.size) return@launch
                        onProgress?.invoke(i + 1, chunks.size)
                        var lastErr: Exception? = null
                        var audio: ByteArray? = null
                        var attempt = 1
                        while (attempt <= maxAttempts && failure.get() == null) {
                            currentCoroutineContext().ensureActive()
                            try {
                                audio = withProviderSlot(budget) { synthesizeChunk(config, chunks[i]) }
                                break
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                lastErr = e
                                if (e is ProviderError && !e.retryable) break
                                if (attempt < maxAttempts) delay(baseDelayMs * (1L shl (attempt - 1)))
                            }
                            attempt++
                        }
                        if (audio == null) {
                            failure.compareAndSet(null, lastErr ?: Exception("TTS: synthesis failed"))
                            return@launch
                        }
                        // Keep the first chunk's tags (players read them); drop the rest.
                        parts[i] = if (config.format == "mp3" && i > 0) stripId3(audio) else audio
                    }
                }
            }
        }
        failure.get()?.let { throw it }
        if (parts.size == 1) return parts[0]!!
        val out = ByteArrayOutputStream(parts.sumOf { it!!.size })
        for (p in parts) out.write(p!!)
        return out.toByteArray()
    }
}
