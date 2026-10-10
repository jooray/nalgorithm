package today.cypherpunk.nalgorithm.byok

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import okhttp3.OkHttpClient
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.engine.LearnedState
import today.cypherpunk.nalgorithm.engine.LikesSource
import today.cypherpunk.nalgorithm.engine.LlmConfig
import today.cypherpunk.nalgorithm.engine.Pipeline
import today.cypherpunk.nalgorithm.engine.PipelineStore
import java.time.Instant

/**
 * Learning from likes on this device (web learning.ts): the learned state per
 * identity under `learned:<hex>`, refreshed at most hourly unless forced.
 */
class Learning(private val records: RecordStore, private val http: OkHttpClient) {
    private val running = HashMap<String, Deferred<String?>>()

    private fun key(s: ByokSettings) = "learned:${s.identityHex ?: "unconfigured"}"

    suspend fun state(s: ByokSettings): LearnedState? = records.get(key(s), LearnedState.serializer())

    /** The learned prompt for this identity, or "". */
    suspend fun prompt(s: ByokSettings): String = state(s)?.prompt ?: ""

    /** One run per identity at a time; a second caller waits for the first. */
    fun learnIncrementally(scope: CoroutineScope, fetcher: LikesSource, s: ByokSettings, force: Boolean = false): Deferred<String?> {
        val k = key(s)
        synchronized(running) { running[k]?.let { return it } }
        val hex = s.identityHex ?: return CompletableDeferred(null)
        val work = scope.async(start = CoroutineStart.LAZY) {
            try {
                val state = state(s)
                val updated = state?.let { runCatching { Instant.parse(it.updatedAt).toEpochMilli() }.getOrNull() }
                if (!force && state != null && updated != null && System.currentTimeMillis() - updated < 60 * 60_000L) {
                    return@async state.prompt
                }
                val store = object : PipelineStore {
                    override suspend fun getLearned() = state
                    override suspend fun putLearned(state: LearnedState) {
                        records.put(k, LearnedState.serializer(), state)
                    }
                }
                Pipeline.refreshLearnedPrompt(
                    fetcher = fetcher,
                    store = store,
                    llm = LlmConfig(s.apiBaseUrl, s.apiKey, s.learnerModel.ifEmpty { s.model }, http = http),
                    pubkeyHex = hex,
                    pauseMs = 0,
                )
            } finally {
                synchronized(running) { running.remove(k) }
            }
        }
        synchronized(running) { running[k] = work }
        work.start()
        return work
    }

    /** Forget the learned taste. Which likes were read is kept, so only likes from now on shape a new one. */
    suspend fun reset(s: ByokSettings) {
        val state = state(s) ?: return
        records.put(key(s), LearnedState.serializer(), state.copy(prompt = "", updatedAt = Instant.now().toString()))
    }
}
