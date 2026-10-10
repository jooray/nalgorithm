package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger

/**
 * Work-conserving pool with a bounded number of active operations (lib work-pool.ts).
 * Workers stop taking items once [deadline] (epoch ms) has passed; results keep input order.
 */
suspend fun <T, R : Any> mapConcurrent(
    items: List<T>,
    limit: Int,
    deadline: Long = Long.MAX_VALUE,
    work: suspend (item: T, index: Int) -> R,
): List<R> {
    if (items.isEmpty()) return emptyList()
    val out = arrayOfNulls<Any>(items.size)
    val next = AtomicInteger(0)
    coroutineScope {
        repeat(minOf(maxOf(1, limit), items.size)) {
            launch {
                while (System.currentTimeMillis() < deadline) {
                    val index = next.getAndIncrement()
                    if (index >= items.size) return@launch
                    out[index] = work(items[index], index)
                }
            }
        }
    }
    @Suppress("UNCHECKED_CAST")
    return out.filterNotNull() as List<R>
}

internal fun <T> List<T>.chunks(size: Int): List<List<T>> = chunked(size)
