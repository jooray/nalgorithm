package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.nostr.Filter
import today.cypherpunk.nalgorithm.nostr.RelayPoolApi
import java.util.Collections

/**
 * Reads what ranking needs from relays (lib fetcher.ts): the follow list, posts from
 * follows classified as original / quote / boost with their embeds resolved and replies
 * left out, the reader's likes with paging, and profiles with fallback and outbox passes.
 */
class Fetcher(
    private val pool: RelayPoolApi,
    private val relays: List<String>,
    /** Asked for profiles only when the main relays had none for a pubkey. */
    private val profileFallbackRelays: List<String> = DEFAULT_PROFILE_RELAYS,
    private val clock: () -> Long = { System.currentTimeMillis() },
) : LikesSource {
    companion object {
        const val DEFAULT_HOURS_BACK = 24
        const val DEFAULT_MAX_POSTS = 500
        const val DEFAULT_LIKES_LIMIT = 200
        /** Max pubkeys per relay filter, to avoid relay rejections. */
        private const val FILTER_AUTHOR_CHUNK = 200
        private const val QUERY_TIMEOUT = 8_000L
        /** Public relays that index kind 0 widely; asked only for pubkeys nobody else knew. */
        val DEFAULT_PROFILE_RELAYS = listOf("wss://purplepag.es", "wss://relay.damus.io")
        /** Indexers are flaky with big author filters; small batches answer reliably. */
        private const val PROFILE_RETRY_CHUNK = 25
        // Outbox pass: each author's own write relays, bounded so it cannot stall a run.
        private const val OUTBOX_MAX_RELAYS_PER_AUTHOR = 3
        private const val OUTBOX_MAX_RELAYS = 12
        private const val OUTBOX_BUDGET_MS = 15_000L
        private const val OUTBOX_QUERY_TIMEOUT = 6_000L

        /**
         * Kind 0 events into profiles, the newest event per pubkey. The name is display_name,
         * else name. Events with unparseable content are skipped.
         */
        fun parseProfileEvents(events: List<NostrEvent>): Map<String, ProfileData> {
            val latest = LinkedHashMap<String, NostrEvent>()
            for (e in events) {
                val existing = latest[e.pubkey]
                if (existing == null || e.createdAt > existing.createdAt) latest[e.pubkey] = e
            }
            val out = LinkedHashMap<String, ProfileData>()
            for ((pubkey, event) in latest) {
                val meta = Js.parse(event.content) as? JsonObject ?: continue
                fun str(key: String) = (meta[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }
                out[pubkey] = ProfileData(
                    pubkey = pubkey,
                    name = str("display_name") ?: str("name"),
                    picture = str("picture"),
                    nip05 = str("nip05"),
                    lud16 = str("lud16"),
                    lud06 = str("lud06"),
                )
            }
            return out
        }

        /** A kind-1 reply: nostr-tools' nip10 finds a root or reply (marked, or positional e tags). */
        internal fun isReply(event: NostrEvent): Boolean =
            event.tags.any { it.size > 1 && it[0] == "e" && it[1].isNotEmpty() && it.getOrNull(3) != "mention" }

        private val QUOTE_REF = Regex("nostr:n(event|ote)1[a-z0-9]+", RegexOption.IGNORE_CASE)
        private val QUOTE_REF_CAPTURE = Regex("nostr:(nevent1[a-z0-9]+|note1[a-z0-9]+)", RegexOption.IGNORE_CASE)

        internal fun isQuotePost(event: NostrEvent): Boolean =
            QUOTE_REF.containsMatchIn(event.content) || event.tags.any { it.firstOrNull() == "e" && it.getOrNull(3) == "mention" }

        /** The quoted event: a q tag, a mention e tag, or a nostr: reference in the text. */
        internal fun getQuotedEventId(event: NostrEvent): String? {
            event.tags.firstOrNull { it.firstOrNull() == "q" }?.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { return it }
            event.tags.firstOrNull { it.firstOrNull() == "e" && it.getOrNull(3) == "mention" }?.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { return it }
            val match = QUOTE_REF_CAPTURE.find(event.content) ?: return null
            return try {
                when (val d = Nip19.decode(match.groupValues[1])) {
                    is Nip19.Decoded.Nevent -> d.id
                    is Nip19.Decoded.Note -> d.id
                    else -> null
                }
            } catch (_: Exception) {
                null
            }
        }

        internal fun getRepostedEventId(event: NostrEvent): String? = event.tags.firstOrNull { it.firstOrNull() == "e" }?.getOrNull(1)

        /** The original event, when a kind 6 carries it as its content. */
        internal fun parseRepostContent(event: NostrEvent): EmbeddedPost? {
            if (event.content.isBlank()) return null
            val parsed = Js.parse(event.content) as? JsonObject ?: return null
            fun str(key: String) = (parsed[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val id = str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val pubkey = str("pubkey")?.takeIf { it.isNotEmpty() } ?: return null
            val content = str("content") ?: return null
            return EmbeddedPost(id, pubkey, content)
        }
    }

    /** EOSE-or-timeout across [urls]; a timeout yields nothing rather than an error. */
    private suspend fun query(urls: List<String>, filter: Filter, timeout: Long = QUERY_TIMEOUT): List<NostrEvent> {
        currentCoroutineContext().ensureActive()
        if (timeout <= 0) return emptyList()
        return withTimeoutOrNull(timeout) { pool.query(urls, listOf(filter), timeout) } ?: emptyList()
    }

    /** The pubkeys a user follows, from their newest kind 3. */
    suspend fun getFollows(pubkey: String): List<String> {
        val hex = pubkeyToHex(pubkey)
        val event = query(relays, Filter(kinds = listOf(3), authors = listOf(hex), limit = 1)).maxByOrNull { it.createdAt } ?: return emptyList()
        return event.tags.filter { it.size > 1 && it[0] == "p" && it[1].isNotEmpty() }.map { it[1] }
    }

    suspend fun getPosts(follows: List<String>, hoursBack: Int = DEFAULT_HOURS_BACK, maxPosts: Int = DEFAULT_MAX_POSTS): List<FetchedPost> {
        val since = clock() / 1000 - hoursBack * 3600L
        if (follows.isEmpty()) return emptyList()

        val allEvents = Collections.synchronizedList(mutableListOf<NostrEvent>())
        val fetchDeadline = clock() + 30_000
        mapConcurrent(follows.chunked(FILTER_AUTHOR_CHUNK), 3, fetchDeadline) { batch, _ ->
            val events = query(
                relays,
                Filter(kinds = listOf(1, 6), authors = batch, since = since, limit = maxPosts),
                minOf(QUERY_TIMEOUT, maxOf(1, fetchDeadline - clock())),
            )
            allEvents.addAll(events)
        }

        val seen = HashSet<String>()
        val unique = synchronized(allEvents) { allEvents.toList() }.filter { seen.add(it.id) }

        data class Resolve(val eventId: String, val index: Int, val quoted: Boolean)
        val results = mutableListOf<FetchedPost>()
        val toResolve = mutableListOf<Resolve>()
        val candidates = unique.filter { it.kind == 6 || (it.kind == 1 && !isReply(it)) }
            .sortedByDescending { it.createdAt }.take(maxPosts)
        for (event in candidates) {
            if (event.kind == 6) {
                val original = parseRepostContent(event)
                val idx = results.size
                results.add(FetchedPost(event.id, PostType.Boost, event.pubkey, original?.content ?: "", event.createdAt, originalPost = original, rawEvent = event))
                // Not embedded: fetch the original.
                if (original == null) getRepostedEventId(event)?.let { toResolve.add(Resolve(it, idx, quoted = false)) }
            } else if (isQuotePost(event)) {
                val quotedId = getQuotedEventId(event)
                val idx = results.size
                results.add(FetchedPost(event.id, PostType.Quote, event.pubkey, event.content, event.createdAt, rawEvent = event))
                if (quotedId != null) toResolve.add(Resolve(quotedId, idx, quoted = true))
            } else {
                results.add(FetchedPost(event.id, PostType.Original, event.pubkey, event.content, event.createdAt, rawEvent = event))
            }
        }

        if (toResolve.isNotEmpty()) {
            val resolved = java.util.concurrent.ConcurrentHashMap<String, EmbeddedPost>()
            val embedDeadline = clock() + 12_000
            mapConcurrent(toResolve.map { it.eventId }.distinct().chunked(50), 3, embedDeadline) { ids, _ ->
                val events = query(relays, Filter(ids = ids), minOf(QUERY_TIMEOUT, maxOf(1, embedDeadline - clock())))
                for (e in events) resolved[e.id] = EmbeddedPost(e.id, e.pubkey, e.content)
            }
            for (r in toResolve) {
                val embed = resolved[r.eventId] ?: continue
                val post = results[r.index]
                results[r.index] = if (r.quoted) {
                    post.copy(quotedPost = embed)
                } else {
                    // A boost with no inline content takes the original's text.
                    post.copy(originalPost = embed, content = post.content.ifEmpty { embed.content })
                }
            }
        }
        return results.sortedByDescending { it.createdAt }.take(maxPosts)
    }

    /** The reader's positive reactions and the notes they point at, with the paging boundary. */
    override suspend fun getLikes(pubkeyHex: String, limit: Int, since: Long?, until: Long?): LikesPage {
        val hex = pubkeyToHex(pubkeyHex)
        val reactions = query(relays, Filter(kinds = listOf(7), authors = listOf(hex), limit = limit, since = since, until = until))
        // Each relay stops at `limit` on its own, so one may reach further back than another. The
        // limit-th newest merged event is no older than the oldest event of any relay that hit the
        // limit, so the next page starts there (inclusive; processed reaction ids drop the overlap).
        val times = reactions.map { it.createdAt }.sortedDescending()
        val boundary = if (times.isEmpty()) null else times[minOf(limit, times.size) - 1]
        val nextUntil = boundary?.let { if (until != null) minOf(it, until - 1) else it }

        val likedIds = reactions.filter { it.content != "-" }
            .mapNotNull { r -> r.tags.firstOrNull { it.firstOrNull() == "e" }?.getOrNull(1)?.takeIf { it.isNotEmpty() } }
        if (likedIds.isEmpty()) return LikesPage(emptyList(), reactions.size, nextUntil)

        val liked = mutableListOf<LikedPostContent>()
        for (ids in likedIds.distinct().chunked(50)) {
            for (e in query(relays, Filter(ids = ids))) {
                // Only kind 1 text notes with actual content.
                if (e.kind == 1 && e.content.trim().isNotEmpty()) {
                    val reaction = reactions.firstOrNull { r -> r.tags.any { it.firstOrNull() == "e" && it.getOrNull(1) == e.id } }
                    liked.add(LikedPostContent(e.id, e.content, e.pubkey, reaction?.id, reaction?.createdAt))
                }
            }
        }
        return LikesPage(liked, reactions.size, nextUntil)
    }

    suspend fun getProfiles(pubkeys: List<String>): Map<String, ProfileData> {
        val profiles = java.util.concurrent.ConcurrentHashMap<String, ProfileData>()
        if (pubkeys.isEmpty()) return profiles
        val unique = pubkeys.distinct()
        val profileDeadline = clock() + 15_000

        // One failed chunk must not lose the profiles the others found.
        suspend fun fetchInto(relayList: List<String>, wanted: List<String>, size: Int = FILTER_AUTHOR_CHUNK, timeout: Long = QUERY_TIMEOUT) {
            mapConcurrent(wanted.chunked(size), 3, profileDeadline) { batch, _ ->
                if (clock() >= profileDeadline) return@mapConcurrent Unit
                try {
                    val events = query(relayList, Filter(kinds = listOf(0), authors = batch), minOf(timeout, maxOf(1, profileDeadline - clock())))
                    profiles.putAll(parseProfileEvents(events))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Relay error: leave these unresolved, the fallback pass may cover them.
                }
                Unit
            }
        }

        suspend fun outboxPass(missing: List<String>, indexers: List<String>) {
            if (missing.isEmpty() || indexers.isEmpty()) return
            val deadline = minOf(profileDeadline, clock() + OUTBOX_BUDGET_MS)
            fun left() = maxOf(0L, deadline - clock())

            // kind 10002 from the indexers, in small batches.
            val newestList = LinkedHashMap<String, NostrEvent>()
            for (batch in missing.chunked(PROFILE_RETRY_CHUNK)) {
                if (left() == 0L) return
                try {
                    for (e in query(indexers, Filter(kinds = listOf(10002), authors = batch), minOf(OUTBOX_QUERY_TIMEOUT, left()))) {
                        if (e.kind != 10002 || e.pubkey !in batch) continue
                        val prev = newestList[e.pubkey]
                        if (prev == null || e.createdAt > prev.createdAt) newestList[e.pubkey] = e
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Try the next batch.
                }
            }

            // Group authors by write relay, preferring relays many authors share.
            val writeRelays = LinkedHashMap<String, List<String>>()
            val popularity = HashMap<String, Int>()
            for ((pubkey, event) in newestList) {
                val urls = mutableListOf<String>()
                for (t in event.tags) {
                    if (t.firstOrNull() != "r" || (t.size > 2 && t[2] != "write")) continue
                    val url = RelayUrl.sanitize(t.getOrNull(1))
                    if (url != null && url !in urls) urls.add(url)
                }
                writeRelays[pubkey] = urls
                for (u in urls) popularity[u] = (popularity[u] ?: 0) + 1
            }
            val byRelay = LinkedHashMap<String, MutableList<String>>()
            for ((pubkey, urls) in writeRelays) {
                for (u in urls.sortedByDescending { popularity[it] ?: 0 }.take(OUTBOX_MAX_RELAYS_PER_AUTHOR)) {
                    byRelay.getOrPut(u) { mutableListOf() }.add(pubkey)
                }
            }
            val targets = byRelay.entries.sortedByDescending { it.value.size }.take(OUTBOX_MAX_RELAYS)
            for ((url, authors) in targets) {
                for (batch in authors.filter { !profiles.containsKey(it) }.chunked(PROFILE_RETRY_CHUNK)) {
                    if (left() == 0L) return
                    fetchInto(listOf(url), batch, PROFILE_RETRY_CHUNK, minOf(OUTBOX_QUERY_TIMEOUT, left()))
                }
            }
        }

        fetchInto(relays, unique)

        // The configured relays often lack kind 0 for people the follow list points at.
        fun stillMissing() = unique.filter { !profiles.containsKey(it) }
        val extra = profileFallbackRelays.filter { it !in relays }
        // Indexers answer big filters partially, so ask in small batches, and twice.
        for (attempt in 0 until 2) {
            if (extra.isEmpty()) break
            val missing = stillMissing()
            if (missing.isEmpty()) break
            fetchInto(extra, missing, PROFILE_RETRY_CHUNK)
        }

        try {
            outboxPass(stillMissing(), extra.ifEmpty { profileFallbackRelays })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Never throw from a best-effort pass; keep whatever resolved.
        }
        return profiles.toMap()
    }
}
