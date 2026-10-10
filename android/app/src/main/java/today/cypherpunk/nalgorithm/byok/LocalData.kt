package today.cypherpunk.nalgorithm.byok

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.engine.DigestWriter
import today.cypherpunk.nalgorithm.engine.Pubkeys
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.DigestSourceNote
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ProfileSnapshot
import today.cypherpunk.nalgorithm.model.ScoredPost

/** The ranking kept on this device, so an offline start shows the last one (web snapshot-logic.ts LocalSnapshot). */
@Serializable
data class FeedSnapshot(
    val v: Int = 1,
    /** Unix seconds of the run the ranking came from. */
    val createdAt: Long,
    val hoursBack: Int? = null,
    /** Fingerprint of the settings the ranking used; a mismatch means it is out of date. */
    val sig: String? = null,
    /** Notes (folded ids) that came with this run and were not in the one before. */
    val fresh: List<String> = emptyList(),
    val posts: List<ScoredPost>,
    val profiles: Map<String, ProfileData> = emptyMap(),
    /** When it was written, so only the newest few identities are kept. */
    val savedAtMs: Long = 0,
)

/**
 * Feed snapshots and digest histories, one record per canonical identity (web
 * local-data.ts and digest-history.ts), so one account never reads another's.
 */
class LocalData(private val records: RecordStore, private val now: () -> Long = { System.currentTimeMillis() }) {
    companion object {
        /** Feed snapshots kept: the current identity plus a couple of recent ones. */
        const val FEED_IDENTITIES = 3
        const val HISTORY_CAP = 30
        /** Roughly 1.5 MB of JSON, and never more than this many posts. */
        const val LOCAL_MAX_BYTES = 1_500_000
        const val LOCAL_MAX_POSTS = 200

        private val HISTORY = ListSerializer(DigestRecord.serializer())

        fun historyKey(hex: String) = "history:byok:$hex"
        fun feedKey(hex: String) = "feed:byok:$hex"

        /** Insert (or replace by id), newest first, capped. */
        fun withDigest(list: List<DigestRecord>, digest: DigestRecord, cap: Int = HISTORY_CAP): List<DigestRecord> =
            (listOf(digest) + list.filter { it.id != digest.id }).sortedByDescending { it.createdAt }.take(cap)

        /**
         * Fit a snapshot under the caps. Posts are in rank order, so the tail goes first; each
         * post and each profile it brings is measured once, in encoded bytes.
         */
        fun trim(snap: FeedSnapshot, maxBytes: Int = LOCAL_MAX_BYTES, maxPosts: Int = LOCAL_MAX_POSTS): FeedSnapshot {
            fun bytes(s: String) = s.toByteArray(Charsets.UTF_8).size
            fun keep(posts: List<ScoredPost>) = Pubkeys.ofScored(posts, Int.MAX_VALUE).toSet()
            val posts = snap.posts.take(maxPosts)
            var total = bytes(AppJson.encodeToString(FeedSnapshot.serializer(), snap.copy(posts = emptyList(), profiles = emptyMap())))
            var kept = 0
            val people = HashSet<String>()
            for (post in posts) {
                val added = keep(listOf(post)).filter { it !in people && it in snap.profiles }
                val size = bytes(AppJson.encodeToString(ScoredPost.serializer(), post)) + 1 +
                    added.sumOf { k -> bytes(k) + 2 + bytes(AppJson.encodeToString(ProfileData.serializer(), snap.profiles.getValue(k))) + 2 }
                if (total + size > maxBytes) break
                total += size
                kept++
                people.addAll(added)
            }
            val keepKeys = keep(posts.take(kept))
            return snap.copy(posts = posts.take(kept), profiles = snap.profiles.filterKeys { it in keepKeys })
        }
    }

    private val historyWrites = Mutex()

    suspend fun loadDigestHistory(hex: String): List<DigestRecord> = records.get(historyKey(hex), HISTORY).orEmpty()

    /** Writes are serialised, so two digests finishing together both survive. */
    suspend fun addDigest(hex: String, digest: DigestRecord): Boolean = historyWrites.withLock {
        runCatching { records.put(historyKey(hex), HISTORY, withDigest(loadDigestHistory(hex), digest)) }.isSuccess
    }

    suspend fun loadFeedSnapshot(hex: String): FeedSnapshot? =
        records.get(feedKey(hex), FeedSnapshot.serializer())?.takeIf { it.v == 1 }

    suspend fun saveFeedSnapshot(hex: String, snap: FeedSnapshot): Boolean {
        val saved = runCatching { records.put(feedKey(hex), FeedSnapshot.serializer(), trim(snap).copy(savedAtMs = now())) }.isSuccess
        // Keep only a few identities' feeds, newest first.
        val all = records.listRaw("feed:byok:").map { (k, v) ->
            k to (runCatching { AppJson.decodeFromString(SavedAt.serializer(), v).savedAtMs }.getOrNull() ?: 0L)
        }.sortedByDescending { it.second }
        for ((k, _) in all.drop(FEED_IDENTITIES)) records.delete(k)
        return saved
    }

    @Serializable
    private data class SavedAt(val savedAtMs: Long = 0)

    /** Everything this mode keeps for one identity. */
    suspend fun clearIdentity(hex: String) {
        records.delete(historyKey(hex))
        records.delete(feedKey(hex))
    }
}

/** Digest records made on this device (web digest-model.ts). */
object LocalDigests {
    private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")
    private const val MAX_NOTE_CHARS = 4000

    /** Validate one source note: hex ids, finite numbers, a bounded text. */
    fun readSourceNote(n: DigestSourceNote): DigestSourceNote? {
        if (!HEX_64.matches(n.id) || !HEX_64.matches(n.pubkey)) return null
        if (n.score.isNaN() || n.score.isInfinite()) return null
        return DigestSourceNote(
            id = n.id.lowercase(),
            pubkey = n.pubkey.lowercase(),
            createdAt = n.createdAt,
            content = n.content.take(MAX_NOTE_CHARS),
            score = n.score.coerceIn(0.0, 10.0),
            reason = n.reason?.trim()?.takeIf { it.isNotEmpty() },
            kind = n.kind?.takeIf { it >= 0 },
            relay = n.relay?.takeIf { Regex("^wss?://\\S+$", RegexOption.IGNORE_CASE).matches(it) },
        )
    }

    /**
     * The record kept after a digest is written here: its text, the notes it was composed
     * from (the same selection as the digest prompt) and the profiles they need offline.
     */
    fun makeLocalDigest(text: String, posts: List<ScoredPost>, topN: Int, profiles: Map<String, ProfileData>, nowMs: Long = System.currentTimeMillis()): DigestRecord {
        val notes = DigestWriter.digestSourceNotes(posts, topN).mapNotNull(::readSourceNote)
        val snap = LinkedHashMap<String, ProfileSnapshot>()
        for (pk in notes.map { it.pubkey }.distinct()) {
            profiles[pk]?.let { p -> snap[pk] = ProfileSnapshot(p.name, p.picture, p.nip05) }
        }
        return DigestRecord(
            id = "local-$nowMs",
            createdAt = nowMs / 1000,
            text = text.trim(),
            audioUrl = null,
            notes = notes,
            profiles = snap.takeIf { it.isNotEmpty() },
        )
    }

    fun wordCount(text: String): Int = text.split(Regex("\\s+")).count { it.isNotEmpty() }
}
