package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

/** The shared queue is full: the provider is busy, so retrying now only lengthens the queue. */
class ProviderBusy : Exception("The model queue is full. Try again shortly.")

/**
 * One budget per provider endpoint and key, shared across scoring, writing,
 * learning, editing and TTS (lib provider-budget.ts).
 */
object ProviderBudget {
    private class Budget {
        var active = 0
        val queue = ArrayDeque<CompletableDeferred<Unit>>()
        var limit = 10
        var rpm = Double.POSITIVE_INFINITY
        var next = 0L
        var requests = 0L
    }

    private val budgets = HashMap<String, Budget>()

    private fun keyOf(apiBaseUrl: String, apiKey: String) = "${apiBaseUrl.replace(Regex("/+$"), "")}\n$apiKey"

    private fun budgetFor(apiBaseUrl: String, apiKey: String): Budget = synchronized(budgets) {
        budgets.getOrPut(keyOf(apiBaseUrl, apiKey)) { Budget() }
    }

    fun configure(apiBaseUrl: String, apiKey: String, concurrency: Int, requestsPerMinute: Double) {
        val b = budgetFor(apiBaseUrl, apiKey)
        synchronized(b) {
            b.limit = concurrency.coerceIn(1, 10)
            b.rpm = maxOf(1.0, requestsPerMinute)
        }
    }

    suspend fun <T> withSlot(apiBaseUrl: String, apiKey: String, work: suspend () -> T): T {
        val b = budgetFor(apiBaseUrl, apiKey)
        currentCoroutineContext().ensureActive()
        var waiter: CompletableDeferred<Unit>? = null
        synchronized(b) {
            if (b.active >= b.limit) {
                if (b.queue.size >= 64) throw ProviderBusy()
                waiter = CompletableDeferred<Unit>().also { b.queue.addLast(it) }
            } else {
                b.active++
            }
        }
        waiter?.let { w ->
            try {
                w.await()
            } catch (e: CancellationException) {
                // A cancelled caller leaves the queue at once; if it was woken in the
                // meantime it already holds a slot, which goes to the next in line.
                val stillQueued = synchronized(b) { b.queue.remove(w) }
                if (!stillQueued) release(b)
                throw e
            }
        }
        try {
            currentCoroutineContext().ensureActive()
            val wait = synchronized(b) {
                val now = System.currentTimeMillis()
                val slot = maxOf(now, b.next)
                b.next = slot + if (b.rpm.isInfinite()) 0L else (60_000.0 / b.rpm).toLong()
                slot - now
            }
            if (wait > 0) delay(wait)
            currentCoroutineContext().ensureActive()
            synchronized(b) { b.requests++ }
            return work()
        } finally {
            release(b)
        }
    }

    private fun release(b: Budget) {
        val next = synchronized(b) {
            val n = b.queue.removeFirstOrNull()
            if (n == null) b.active--
            n
        }
        next?.complete(Unit)
    }

    data class Stats(val active: Int, val queued: Int, val requests: Long)

    /** Aggregate diagnostics only: no keys, prompts or user identities. */
    fun stats(): Stats = synchronized(budgets) {
        budgets.values.fold(Stats(0, 0, 0)) { acc, b ->
            synchronized(b) { Stats(acc.active + b.active, acc.queued + b.queue.size, acc.requests + b.requests) }
        }
    }
}

suspend fun <T> withProviderSlot(config: LlmConfig, work: suspend () -> T): T =
    ProviderBudget.withSlot(config.apiBaseUrl, config.apiKey, work)
