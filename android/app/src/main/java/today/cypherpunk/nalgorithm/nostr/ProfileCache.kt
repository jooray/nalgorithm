package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ProfileSnapshot

/**
 * Every profile known on this device (web: profiles.ts, lazy-profiles.ts). The
 * feed hands over the profiles it already has; anyone still unknown is looked
 * up from the reader's relays (then the fallback indexers and the author's own
 * relays), each person once per app run. Profiles are public Nostr data and are
 * kept in the record store (`profile:<hex>`), so names and pictures show at
 * once on the next launch.
 */
class ProfileCache internal constructor(
    private val pool: RelayPoolApi,
    private val records: RecordStore?,
    private val fallbackRelays: List<String> = Profiles.DEFAULT_PROFILE_RELAYS,
    private val batchWindowMs: Long = BATCH_WINDOW_MS,
) {
    constructor(pool: RelayPool, records: RecordStore) : this(pool as RelayPoolApi, records)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    /** Recency order for the cap: the oldest entries go first. */
    private val order = LinkedHashMap<String, Long>(16, 0.75f, true)
    private val tried = LinkedHashSet<String>()
    private val inFlight = HashMap<String, CompletableDeferred<Unit>>()

    private val _profiles = MutableStateFlow<Map<String, ProfileData>>(emptyMap())
    /** Every profile known on this device, by hex pubkey. */
    val profiles: StateFlow<Map<String, ProfileData>> = _profiles.asStateFlow()

    private val loaded = CompletableDeferred<Unit>()

    // Declared before init: the batcher starts there, on another thread, and must find it set.
    private val lookups = Channel<Lookup>(Channel.UNLIMITED)

    init {
        if (records == null) loaded.complete(Unit) else scope.launch { restore() }
        scope.launch { batcher() }
    }

    @Serializable
    internal data class Stored(val p: ProfileData, val at: Long)

    private suspend fun restore() {
        try {
            val rows = records!!.list(PREFIX, Stored.serializer()).sortedByDescending { it.second.at }
            val keep = rows.take(PROFILE_CACHE_MAX)
            synchronized(lock) {
                val next = LinkedHashMap(_profiles.value)
                for ((_, s) in keep.asReversed()) {
                    if (next.containsKey(s.p.pubkey)) continue
                    next[s.p.pubkey] = s.p
                    order[s.p.pubkey] = s.at
                }
                _profiles.value = next
            }
            rows.drop(PROFILE_CACHE_MAX).forEach { records.delete(it.first) }
        } catch (e: Exception) {
            // An unreadable store only means names load from relays again.
        } finally {
            loaded.complete(Unit)
        }
    }

    /** Remember profiles the feed already has, so nobody looks them up again. */
    fun remember(profiles: Map<String, ProfileData>) {
        if (profiles.isEmpty()) return
        val changed = LinkedHashMap<String, ProfileData>()
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val next = LinkedHashMap(_profiles.value)
            for ((pk, p) in profiles) {
                val clean = p.copy(pubkey = pk)
                if (next[pk] != clean) changed[pk] = clean
                next[pk] = clean
                order[pk] = now
            }
            trim(next)
            _profiles.value = next
        }
        if (changed.isNotEmpty() && records != null) {
            scope.launch {
                runCatching {
                    records.putAllRaw(changed.mapKeys { PREFIX + it.key }.mapValues { (_, p) -> relayJsonOut.encodeToString(Stored.serializer(), Stored(p, now)) })
                }
            }
        }
    }

    /** A stored snapshot (digest show notes) without overriding a fresher profile. */
    fun rememberSnapshots(snapshots: Map<String, ProfileSnapshot>?) {
        if (snapshots.isNullOrEmpty()) return
        val known = _profiles.value
        val fresh = snapshots.filterKeys { it !in known }.mapValues { (pk, s) -> ProfileData(pk, s.name, s.picture, s.nip05) }
        if (fresh.isEmpty()) return
        synchronized(lock) {
            val next = LinkedHashMap(_profiles.value)
            for ((pk, p) in fresh) if (!next.containsKey(pk)) {
                next[pk] = p
                order[pk] = System.currentTimeMillis()
            }
            trim(next)
            _profiles.value = next
        }
    }

    private fun trim(next: MutableMap<String, ProfileData>) {
        while (order.size > PROFILE_CACHE_MAX) {
            val oldest = order.keys.first()
            order.remove(oldest)
            next.remove(oldest)
        }
    }

    /** What is known right now for these people. */
    fun known(pubkeys: Collection<String>): Map<String, ProfileData> {
        val all = _profiles.value
        return pubkeys.mapNotNull { pk -> all[pk]?.let { pk to it } }.toMap()
    }

    private class Lookup(val pubkeys: List<String>, val relays: List<String>, val done: CompletableDeferred<Unit>)


    /**
     * Known ones at once, the rest fetched from [relays] (with fallback profile
     * relays). Lookups arriving close together are asked in one batch. Each
     * person is tried once per run; a failed relay leaves them unresolved.
     */
    suspend fun load(pubkeys: Collection<String>, relays: List<String>): Map<String, ProfileData> {
        val wanted = pubkeys.filter { Hex.isHex64(it) }.distinct()
        if (wanted.isEmpty()) return emptyMap()
        withTimeoutOrNull(2_000) { loaded.await() }
        val waits = mutableListOf<CompletableDeferred<Unit>>()
        val missing = mutableListOf<String>()
        synchronized(lock) {
            val known = _profiles.value
            for (pk in wanted) {
                if (known.containsKey(pk)) continue
                inFlight[pk]?.let { waits.add(it); continue }
                if (pk in tried) continue
                tried.add(pk)
                missing.add(pk)
            }
            // Past the cap the oldest misses may be tried again; cheaper than an unbounded set.
            while (tried.size > PROFILE_CACHE_MAX) tried.remove(tried.first())
            if (missing.isNotEmpty() && relays.isNotEmpty()) {
                val done = CompletableDeferred<Unit>()
                missing.forEach { inFlight[it] = done }
                waits.add(done)
                lookups.trySend(Lookup(missing, relays, done))
            }
        }
        waits.forEach { it.await() }
        return known(wanted)
    }

    private suspend fun batcher() {
        while (true) {
            val first = lookups.receive()
            delay(batchWindowMs)
            val batch = mutableListOf(first)
            while (true) batch.add(lookups.tryReceive().getOrNull() ?: break)
            for ((relays, group) in batch.groupBy { it.relays.mapNotNull(::relayKey).distinct().sorted() }) {
                scope.launch {
                    val pubkeys = group.flatMap { it.pubkeys }.distinct()
                    try {
                        val found = Profiles.fetch(pool, pubkeys, relays.ifEmpty { group.first().relays }, fallbackRelays)
                        remember(found)
                    } catch (e: Exception) {
                        // Names stay as npubs.
                    } finally {
                        synchronized(lock) { pubkeys.forEach { pk -> if (group.any { inFlight[pk] === it.done }) inFlight.remove(pk) } }
                        group.forEach { it.done.complete(Unit) }
                    }
                }
            }
        }
    }

    companion object {
        private const val PREFIX = "profile:"
        /** A long session meets many people; the oldest entries go first past this many. */
        const val PROFILE_CACHE_MAX = 5000
        const val BATCH_WINDOW_MS = 40L
        private val relayJsonOut = today.cypherpunk.nalgorithm.core.AppJson
    }
}
