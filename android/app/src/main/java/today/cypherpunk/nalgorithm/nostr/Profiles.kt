package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/** Kind 0 parsing and lookup (lib/src/fetcher.ts getProfiles, parseProfileEvents). */
object Profiles {
    // Public relays that index kind 0 widely; asked only for pubkeys nobody else knew.
    val DEFAULT_PROFILE_RELAYS = listOf("wss://purplepag.es", "wss://relay.damus.io")

    private const val FILTER_AUTHOR_CHUNK = 200
    private const val QUERY_TIMEOUT = 8_000L
    // Indexers are flaky with big author filters; small batches answer reliably.
    private const val PROFILE_RETRY_CHUNK = 25
    private const val OUTBOX_MAX_RELAYS_PER_AUTHOR = 3
    private const val OUTBOX_MAX_RELAYS = 12
    private const val OUTBOX_BUDGET_MS = 15_000L
    private const val OUTBOX_QUERY_TIMEOUT = 6_000L
    private const val PROFILE_BUDGET_MS = 15_000L

    // Field limits: a profile is someone else's input and ends up on screen and on disk.
    private const val MAX_NAME = 256
    private const val MAX_NIP05 = 256
    private const val MAX_PICTURE = 1000
    private const val MAX_LUD16 = 256
    private const val MAX_LUD06 = 2048

    /**
     * Turn kind 0 events into profiles, keeping the newest event per pubkey.
     * The name is display_name, else name. Events with unparseable content are
     * skipped. Pictures are kept only as http(s) URLs.
     */
    fun parseProfileEvents(events: List<NostrEvent>): Map<String, ProfileData> {
        val latest = LinkedHashMap<String, NostrEvent>()
        for (event in events) {
            val existing = latest[event.pubkey]
            if (existing == null || event.createdAt > existing.createdAt) latest[event.pubkey] = event
        }
        val out = LinkedHashMap<String, ProfileData>()
        for ((pubkey, event) in latest) {
            val meta = runCatching { relayJson.parseToJsonElement(event.content) }.getOrNull() ?: continue
            if (meta is JsonNull) continue
            val obj = meta as? JsonObject
            fun str(k: String, max: Int): String? =
                (obj?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }?.take(max)
            out[pubkey] = ProfileData(
                pubkey = pubkey,
                name = str("display_name", MAX_NAME) ?: str("name", MAX_NAME),
                picture = str("picture", MAX_PICTURE)?.takeIf(::isHttpUrl),
                nip05 = str("nip05", MAX_NIP05),
                lud16 = str("lud16", MAX_LUD16),
                lud06 = str("lud06", MAX_LUD06),
            )
        }
        return out
    }

    fun isHttpUrl(value: String): Boolean {
        val u = runCatching { URI(value) }.getOrNull() ?: return false
        val scheme = u.scheme?.lowercase()
        return (scheme == "http" || scheme == "https") && !u.host.isNullOrEmpty() && value.none { it.isWhitespace() }
    }

    private fun <T> List<T>.chunks(size: Int): List<List<T>> = chunked(size)

    /** lib work-pool mapConcurrent: at most [limit] at a time, and nothing new starts after [deadline]. */
    private suspend fun <T> mapConcurrent(items: List<T>, limit: Int, deadline: Long, fn: suspend (T) -> Unit) = coroutineScope {
        val gate = Semaphore(limit)
        items.map { item ->
            async {
                gate.withPermit {
                    if (System.currentTimeMillis() < deadline) fn(item)
                }
            }
        }.awaitAll()
    }

    /**
     * Profiles for [pubkeys]: from [relays], then (for the ones nobody had) the
     * fallback indexers twice in small batches, then each author's own write
     * relays (outbox). Never throws; a failed relay leaves people unresolved.
     */
    suspend fun fetch(
        pool: RelayPoolApi,
        pubkeys: Collection<String>,
        relays: List<String>,
        fallbackRelays: List<String> = DEFAULT_PROFILE_RELAYS,
    ): Map<String, ProfileData> {
        val profiles = java.util.concurrent.ConcurrentHashMap<String, ProfileData>()
        val unique = pubkeys.distinct()
        if (unique.isEmpty()) return profiles
        val profileDeadline = System.currentTimeMillis() + PROFILE_BUDGET_MS

        suspend fun fetchInto(relayList: List<String>, wanted: List<String>, size: Int = FILTER_AUTHOR_CHUNK, timeout: Long = QUERY_TIMEOUT) {
            mapConcurrent(wanted.chunks(size), 3, profileDeadline) { batch ->
                try {
                    val left = (profileDeadline - System.currentTimeMillis()).coerceAtLeast(1)
                    val events = pool.query(relayList, listOf(Filter(kinds = listOf(0), authors = batch)), minOf(timeout, left))
                    profiles.putAll(parseProfileEvents(events.filter { it.kind == 0 && it.pubkey in batch }))
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Relay error: leave these unresolved, the fallback pass may cover them.
                }
            }
        }

        suspend fun outboxPass(missing: List<String>, indexers: List<String>) {
            if (missing.isEmpty() || indexers.isEmpty()) return
            val deadline = minOf(profileDeadline, System.currentTimeMillis() + OUTBOX_BUDGET_MS)
            fun left() = (deadline - System.currentTimeMillis()).coerceAtLeast(0)

            val newestList = LinkedHashMap<String, NostrEvent>()
            for (batch in missing.chunks(PROFILE_RETRY_CHUNK)) {
                if (left() == 0L) return
                try {
                    val events = pool.query(indexers, listOf(Filter(kinds = listOf(10002), authors = batch)), minOf(OUTBOX_QUERY_TIMEOUT, left()))
                    for (e in events) {
                        if (e.kind != 10002 || e.pubkey !in batch) continue
                        val prev = newestList[e.pubkey]
                        if (prev == null || e.createdAt > prev.createdAt) newestList[e.pubkey] = e
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Try the next batch.
                }
            }

            // Group authors by write relay, preferring relays many authors share.
            val writeRelays = LinkedHashMap<String, List<String>>()
            val popularity = HashMap<String, Int>()
            for ((pubkey, event) in newestList) {
                val urls = mutableListOf<String>()
                for (t in event.tags) {
                    if (t.getOrNull(0) != "r" || (t.size > 2 && t[2] != "write")) continue
                    val url = sanitizeRelayUrl(t.getOrNull(1)) ?: continue
                    if (url !in urls) urls.add(url)
                }
                writeRelays[pubkey] = urls
                for (u in urls) popularity[u] = (popularity[u] ?: 0) + 1
            }
            val byRelay = LinkedHashMap<String, MutableList<String>>()
            for ((pubkey, urls) in writeRelays) {
                val pick = urls.sortedByDescending { popularity[it] ?: 0 }.take(OUTBOX_MAX_RELAYS_PER_AUTHOR)
                for (u in pick) byRelay.getOrPut(u) { mutableListOf() }.add(pubkey)
            }
            val targets = byRelay.entries.sortedByDescending { it.value.size }.take(OUTBOX_MAX_RELAYS)
            for ((url, authors) in targets) {
                for (batch in authors.filter { !profiles.containsKey(it) }.chunks(PROFILE_RETRY_CHUNK)) {
                    if (left() == 0L) return
                    fetchInto(listOf(url), batch, PROFILE_RETRY_CHUNK, minOf(OUTBOX_QUERY_TIMEOUT, left()))
                }
            }
        }

        fetchInto(relays, unique)
        fun stillMissing() = unique.filter { !profiles.containsKey(it) }
        val extra = fallbackRelays.filter { it !in relays }
        // Big author filters get partial answers from indexers, so ask in small
        // batches and ask twice: a second attempt picks up what the first skipped.
        for (attempt in 0 until 2) {
            if (extra.isEmpty()) break
            val missing = stillMissing()
            if (missing.isEmpty()) break
            fetchInto(extra, missing, PROFILE_RETRY_CHUNK)
        }
        try {
            outboxPass(stillMissing(), extra.ifEmpty { fallbackRelays })
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Never throw from a best-effort pass; keep whatever resolved.
        }
        return HashMap(profiles)
    }

    // ─── Relay URLs from other people's events (lib/src/relay-url.ts) ────────

    private const val MAX_URL_LENGTH = 200

    private fun ipv4Private(a: Int, b: Int): Boolean =
        a == 0 || a == 10 || a == 127 || a >= 224 ||
            (a == 100 && b in 64..127) || (a == 169 && b == 254) ||
            (a == 172 && b in 16..31) || (a == 192 && b == 168)

    private fun hostIsPrivate(hostname: String): Boolean {
        val host = hostname.removePrefix("[").removeSuffix("]").lowercase()
        if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) {
            val parts = host.split('.').map { it.toInt() }
            return ipv4Private(parts[0], parts[1])
        }
        if (host.contains(':')) {
            if (host == "::" || host == "::1") return true
            val addr = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return true
            val bytes = addr.address
            if (addr !is Inet6Address) {
                // v4-mapped (::ffff:a.b.c.d) comes back as an Inet4Address.
                return ipv4Private(bytes[0].toInt() and 0xff, bytes[1].toInt() and 0xff)
            }
            val first = ((bytes[0].toInt() and 0xff) shl 8) or (bytes[1].toInt() and 0xff)
            return (first and 0xfe00) == 0xfc00 || (first and 0xffc0) == 0xfe80 || (first and 0xff00) == 0xff00
        }
        return host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
            host.endsWith(".internal") || host.endsWith(".lan") || !host.contains('.')
    }

    /**
     * Normalise a relay URL taken from someone else's event, or null if we must
     * not connect to it: only public wss:// hosts pass.
     */
    fun sanitizeRelayUrl(url: String?): String? {
        if (url == null || url.length > MAX_URL_LENGTH) return null
        val u = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        if (u.scheme?.lowercase() != "wss") return null
        val host = u.host?.lowercase() ?: return null
        if (u.rawUserInfo != null || hostIsPrivate(host)) return null
        val port = if (u.port == -1 || u.port == 443) "" else ":${u.port}"
        val path = u.rawPath.orEmpty()
        val query = u.rawQuery?.let { "?$it" }.orEmpty()
        val text = "wss://$host$port${path.ifEmpty { "/" }}$query"
        return if ((path.isEmpty() || path == "/") && query.isEmpty()) text.dropLast(1) else text
    }
}

/** Which people a post shows (web: lazy-profiles.ts, lib pubkeys.ts). */
object People {
    private val HEX_64 = Regex("^[0-9a-f]{64}$")
    private val REF = Regex("nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)", RegexOption.IGNORE_CASE)

    /** Hex pubkeys named by `nostr:npub1…` / `nostr:nprofile1…` references in text. */
    fun extractReferencedPubkeys(content: String, out: MutableSet<String> = LinkedHashSet()): MutableSet<String> {
        for (m in REF.findAll(content)) {
            when (val d = Nip19.decode(m.groupValues[1].lowercase())) {
                is Nip19.Npub -> out.add(d.pubkey)
                is Nip19.Nprofile -> out.add(d.pubkey)
                else -> Unit
            }
        }
        return out
    }

    /** The people a card names: author, boosters, original and quoted authors, and every @mention in the text. */
    fun peopleOf(post: ScoredPost, boostedBy: List<String> = emptyList()): List<String> {
        val out = LinkedHashSet<String>()
        fun add(pk: String?) {
            if (pk != null && HEX_64.matches(pk)) out.add(pk)
        }
        add(post.author)
        boostedBy.forEach(::add)
        add(post.originalPost?.author)
        add(post.quotedPost?.author)
        for (text in listOf(post.content, post.originalPost?.content, post.quotedPost?.content)) {
            if (text != null) extractReferencedPubkeys(text).forEach(::add)
        }
        return out.toList()
    }

    /** People shown by these posts who have no profile at all yet, in first-seen order. */
    fun unresolvedPeople(posts: List<ScoredPost>, profiles: Map<String, ProfileData>?): List<String> {
        val out = LinkedHashSet<String>()
        for (post in posts) for (pk in peopleOf(post)) if (profiles?.containsKey(pk) != true) out.add(pk)
        return out.toList()
    }
}
