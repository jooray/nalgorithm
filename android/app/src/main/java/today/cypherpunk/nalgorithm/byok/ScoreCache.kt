package today.cypherpunk.nalgorithm.byok

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.engine.RankingContext
import java.time.LocalDate
import java.time.ZoneOffset

@Serializable
data class ScoreEntry(
    val score: Double,
    val justification: String? = null,
    /** Which scorer produced it; absent means chat. */
    val scorer: String? = null,
)

/**
 * The score cache (web settings.ts): one record per ranking context and UTC day,
 * `scores:<identity>_<context>_<YYYY-MM-DD>` → { scoreKey: entry }. The context is a
 * fingerprint of the words, model, scorer, endpoint and learning switch, so changing
 * any of them ranks again; the API key never takes part.
 */
class ScoreCache(private val records: RecordStore, private val today: () -> LocalDate = { LocalDate.now(ZoneOffset.UTC) }) {
    companion object {
        const val PREFIX = "scores:"
        private const val MAX_AGE_DAYS = 30L
        private val BUCKET = MapSerializer(String.serializer(), ScoreEntry.serializer())

        fun namespace(s: ByokSettings): String {
            val identity = s.identityHex ?: s.npub.trim()
            val context = RankingContext.rankingContext(s.userPrompt, s.scoringModel, s.scorer, s.apiBaseUrl, s.learnFromLikes)
            return "${identity}_${context}_"
        }
    }

    private val writes = Mutex()

    /** All day buckets of this ranking context, merged. */
    suspend fun load(s: ByokSettings): Map<String, ScoreEntry> {
        val merged = HashMap<String, ScoreEntry>()
        for ((_, bucket) in records.list(PREFIX + namespace(s), BUCKET)) merged.putAll(bucket)
        return merged
    }

    /** Add entries to today's bucket. Writes are serialised, so batches landing together all survive. */
    suspend fun put(s: ByokSettings, entries: Map<String, ScoreEntry>) {
        if (entries.isEmpty()) return
        val key = PREFIX + namespace(s) + today().toString()
        writes.withLock {
            val bucket = HashMap(records.get(key, BUCKET).orEmpty())
            bucket.putAll(entries)
            records.put(key, BUCKET, bucket)
        }
    }

    /** Drop day buckets older than 30 days. Returns how many went. */
    suspend fun prune(): Int {
        val cutoff = today().minusDays(MAX_AGE_DAYS)
        var removed = 0
        writes.withLock {
            for ((key, _) in records.listRaw(PREFIX)) {
                val date = runCatching { LocalDate.parse(key.takeLast(10)) }.getOrNull() ?: continue
                if (date.isBefore(cutoff)) {
                    records.delete(key)
                    removed++
                }
            }
        }
        return removed
    }

    suspend fun clear() = writes.withLock { records.clear(PREFIX) }
}
