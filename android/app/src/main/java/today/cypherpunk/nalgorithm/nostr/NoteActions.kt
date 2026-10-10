package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.util.concurrent.ConcurrentHashMap

enum class Mark { Liked, Boosted, Zapped }

/** The reader backed out of connecting a signer; nothing was sent and nothing needs saying. */
class ActionCancelled : Exception("Cancelled")

/**
 * Public note actions (web: actions.ts, note-ui.ts, relays.ts, note-state.ts).
 * Each asks for a signer when none is connected, signs with the reader's key
 * only, publishes to the reader's write relays plus the author's read relays,
 * and says plainly how many relays took it.
 *
 * Like and boost report through toasts themselves (with Retry), as the web
 * does; [reply] returns the failure text for the composer to show. The
 * composer, boost confirmation and zap flow are [ReplySheet],
 * [BoostConfirmSheet] and [ZapSheet].
 */
class NoteActions(private val graph: AppGraph) {
    private val pool: RelayPool get() = graph.relayPool

    // ─── Marks: what this reader did to which note, on this device ───────────

    private val _marks = MutableStateFlow<Map<String, Set<Mark>>>(emptyMap())
    private val states = ConcurrentHashMap<String, NoteLogic.NoteState>()
    @Volatile private var markReader: String? = null
    @Volatile private var watching = false

    /** Note id → what the current reader did to it on this device. */
    val marks: StateFlow<Map<String, Set<Mark>>>
        get() {
            watchReader()
            return _marks.asStateFlow()
        }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun watchReader() {
        if (watching) return
        synchronized(this) {
            if (watching) return
            watching = true
        }
        graph.scope.launch(Dispatchers.Main) {
            graph.modeStore.mode
                .flatMapLatest { m -> m?.let { graph.controller(it).reader } ?: flowOf(null) }
                .collect { reader ->
                    val pk = reader?.lowercase()
                    markReader = pk
                    if (pk == null) {
                        _marks.value = emptyMap()
                    } else {
                        stateOf(pk)
                        publishMarks()
                    }
                }
        }
    }

    private suspend fun stateOf(pubkey: String): NoteLogic.NoteState {
        states[pubkey]?.let { return it }
        val raw = runCatching { graph.records.getRaw(MARKS_PREFIX + pubkey) }.getOrNull()
        val parsed = NoteLogic.parseNoteState(raw)
        return states.putIfAbsent(pubkey, parsed) ?: parsed
    }

    private fun publishMarks() {
        val pk = markReader ?: return
        val s = states[pk] ?: return
        _marks.value = marksView(s)
    }

    /** Sats this device zapped to a note, for the current reader. */
    fun zappedSats(id: String): Long? = markReader?.let { states[it]?.zapped?.get(id) }

    private suspend fun setMark(pubkey: String, mark: Mark, id: String, value: Long = nowSeconds()) {
        val state = stateOf(pubkey)
        val next = when (mark) {
            Mark.Liked -> state.copy(liked = state.liked + (id to value))
            Mark.Boosted -> state.copy(boosted = state.boosted + (id to value))
            Mark.Zapped -> state.copy(zapped = state.zapped + (id to (state.zapped[id] ?: 0) + value))
        }
        val trimmed = NoteLogic.trimNoteState(next)
        states[pubkey] = trimmed
        publishMarks()
        runCatching { graph.records.putRaw(MARKS_PREFIX + pubkey, NoteLogic.noteStateJson(trimmed)) }
    }

    /** Undo a mark that was set optimistically and then failed. */
    private suspend fun clearMark(pubkey: String, mark: Mark, id: String) {
        val state = stateOf(pubkey)
        val next = when (mark) {
            Mark.Liked -> state.copy(liked = state.liked - id)
            Mark.Boosted -> state.copy(boosted = state.boosted - id)
            Mark.Zapped -> state.copy(zapped = state.zapped - id)
        }
        states[pubkey] = next
        publishMarks()
        runCatching { graph.records.putRaw(MARKS_PREFIX + pubkey, NoteLogic.noteStateJson(next)) }
    }

    private suspend fun isMarked(mark: Mark, id: String): Boolean {
        watchReader()
        val reader = readerKey() ?: return false
        val s = stateOf(reader)
        return when (mark) {
            Mark.Liked -> id in s.liked
            Mark.Boosted -> id in s.boosted
            Mark.Zapped -> id in s.zapped
        }
    }

    internal suspend fun markZapped(pubkey: String, id: String, sats: Long) = setMark(pubkey, Mark.Zapped, id, sats)

    // ─── Who, where ──────────────────────────────────────────────────────────

    internal fun readerKey(): String? = graph.active?.reader?.value?.lowercase()?.takeIf(Hex::isHex64)

    /** The relays the mode reads from; the fallback for everything. */
    internal fun defaultRelays(): List<String> =
        (graph.active?.relays() ?: emptyList()).map(NoteLogic::normalizeRelay).filter { it.isNotEmpty() }.distinct()

    private class ListEntry(val at: Long, val list: Deferred<NoteLogic.RelayList?>)

    private val lists = java.util.Collections.synchronizedMap(LinkedHashMap<String, ListEntry>())

    /** A person's relay list (NIP-65, from the indexers), or null. Cached for the run; misses for ten minutes. */
    internal suspend fun getRelayList(pubkey: String): NoteLogic.RelayList? {
        val entry = synchronized(lists) {
            val cached = lists[pubkey]
            val stale = cached != null && System.currentTimeMillis() - cached.at > MISS_TTL_MS &&
                cached.list.isCompleted && runCatching { cached.list.getCompleted() }.getOrNull() == null
            if (cached != null && !stale) {
                cached
            } else {
                val d = CompletableDeferred<NoteLogic.RelayList?>()
                ListEntry(System.currentTimeMillis(), d).also {
                    lists[pubkey] = it
                    if (lists.size > LISTS_MAX) lists.remove(lists.keys.first())
                    graph.scope.launch(Dispatchers.IO) {
                        d.complete(
                            runCatching {
                                val events = pool.query(INDEXER_RELAYS, listOf(Filter(kinds = listOf(10002), authors = listOf(pubkey), limit = 3)), LIST_TIMEOUT_MS)
                                val newest = events.filter { it.pubkey == pubkey }.maxByOrNull { it.createdAt } ?: return@runCatching null
                                NoteLogic.parseRelayList(newest.tags).takeIf { l -> l.read.size + l.write.size > 0 }
                            }.getOrNull(),
                        )
                    }
                }
            }
        }
        return entry.list.await()
    }

    /** Where an event from [self] goes: their write relays (defaults when unknown) plus [parent]'s read relays. */
    internal suspend fun publishRelaysFor(self: String, parent: String?): List<String> = coroutineScope {
        val mine = async { getRelayList(self) }
        val theirs = async { if (parent != null && parent != self) getRelayList(parent) else null }
        NoteLogic.selectPublishRelays(mine.await()?.write, defaultRelays(), theirs.await()?.read)
    }

    /** Relays to ask for a note: hints, then the author's write relays, then the configured ones. */
    internal suspend fun readRelaysFor(author: String?, hints: List<String> = emptyList()): List<String> {
        val theirs = author?.let { getRelayList(it) }
        return (hints + (theirs?.write ?: emptyList()).take(3) + defaultRelays())
            .map(NoteLogic::normalizeRelay).filter { it.isNotEmpty() }.distinct().take(8)
    }

    internal suspend fun fetchEvent(id: String, relays: List<String>): NostrEvent? =
        runCatching { pool.get(relays, Filter(ids = listOf(id)), FETCH_TIMEOUT_MS) }.getOrNull()?.takeIf { it.id == id }

    /** The newest kind 0 metadata of a person, parsed, or null. */
    internal suspend fun fetchMetadata(pubkey: String, relays: List<String>): JsonObject? {
        val events = runCatching {
            pool.query((relays + INDEXER_RELAYS).distinct(), listOf(Filter(kinds = listOf(0), authors = listOf(pubkey), limit = 5)), FETCH_TIMEOUT_MS)
        }.getOrDefault(emptyList())
        val newest = events.filter { it.pubkey == pubkey }.maxByOrNull { it.createdAt } ?: return null
        return runCatching { relayJson.parseToJsonElement(newest.content) as? JsonObject }.getOrNull()
    }

    // ─── Targets ─────────────────────────────────────────────────────────────

    /** A note as the actions see it. A boost acts on the note it boosts. */
    internal data class NoteTarget(
        val id: String,
        val author: String,
        val kind: Int,
        val relay: String?,
        /** The full event when we have it (bring-your-own-key feed). */
        val event: NostrEvent?,
        val content: String,
        /** Name to show in sheets. */
        val authorName: String,
    ) {
        val logic get() = NoteLogic.Target(id, author, event?.kind ?: kind, relay)
    }

    internal fun targetOf(post: ScoredPost): NoteTarget {
        val original = post.originalPost
        if (post.type == PostType.Boost && original != null) {
            val embedded = post.rawEvent?.takeIf { it.kind == 6 || it.kind == 16 }?.content
                ?.let { runCatching { parseEvent(relayJson.parseToJsonElement(it)) }.getOrNull() }
                ?.takeIf { it.id == original.id && it.verify() }
            return NoteTarget(original.id, original.author, embedded?.kind ?: 1, null, embedded, original.content, authorName(original.author))
        }
        val event = post.rawEvent?.takeIf { it.id == post.id }
        return NoteTarget(post.id, post.author, event?.kind ?: 1, null, event, post.content, authorName(post.author))
    }

    internal fun authorName(pubkey: String): String {
        val name = graph.profiles.profiles.value[pubkey]?.name?.trim()
        if (!name.isNullOrEmpty() && !Regex("^[0-9a-fA-F]{64}$").matches(name)) return name
        return shortNpub(Nip19.npub(pubkey))
    }

    private suspend fun relayHint(t: NoteTarget): String = t.relay ?: getRelayList(t.author)?.write?.firstOrNull() ?: ""

    /** The full original event, for a boost or a reply: the one we hold, else from relays (hosted posts carry none). */
    internal suspend fun originalOf(t: NoteTarget): NostrEvent? =
        t.event ?: fetchEvent(t.id, readRelaysFor(t.author, listOfNotNull(t.relay)))

    // ─── Signer ──────────────────────────────────────────────────────────────

    /**
     * A signer for the signed-in key, or null when the reader backs out. With
     * none available it opens the "Sign in with a signer" sheet; a signer for
     * another key is refused there with its own explanation.
     */
    internal suspend fun requireSigner(): NostrSigner? {
        val reader = readerKey()
        reader?.let { graph.signers.signerFor(it) }?.let { return it }
        val result = withContext(Dispatchers.Main) { graph.signers.requestSigner(SignInPurpose.Actions, reader) } ?: return null
        return result.signer
    }

    // ─── Like ────────────────────────────────────────────────────────────────

    private val inFlight = ConcurrentHashMap.newKeySet<String>()

    suspend fun like(post: ScoredPost): Result<Unit> {
        val t = targetOf(post)
        if (isMarked(Mark.Liked, t.id)) {
            graph.toasts.show("You liked this. Nostr likes cannot be taken back from here.")
            return Result.success(Unit)
        }
        val key = "like:${t.id}"
        if (!inFlight.add(key)) return Result.success(Unit)
        try {
            val signer = requireSigner() ?: return Result.failure(ActionCancelled())
            setMark(signer.pubkey, Mark.Liked, t.id) // optimistic: the heart fills now
            return try {
                val target = t.logic.copy(relay = relayHint(t))
                val event = signChecked(signer, NoteLogic.likeTemplate(target))
                val results = pool.publishDetailed(publishRelaysFor(signer.pubkey, t.author), event, PUBLISH_TIMEOUT_MS)
                if (results.none { it.ok }) throw IllegalStateException(NoteLogic.describePublish(results))
                graph.toasts.show("Liked. ${NoteLogic.describePublish(results)}.")
                Result.success(Unit)
            } catch (e: CancellationException) {
                clearMark(signer.pubkey, Mark.Liked, t.id)
                throw e
            } catch (e: Exception) {
                clearMark(signer.pubkey, Mark.Liked, t.id)
                graph.toasts.show("Could not like: ${e.message}", "Retry") { graph.scope.launch { like(post) } }
                Result.failure(e)
            }
        } finally {
            inFlight.remove(key)
        }
    }

    // ─── Boost ───────────────────────────────────────────────────────────────

    /** Publish a boost. The confirmation ("Boost this note?") is [BoostConfirmSheet]'s job. */
    suspend fun boost(post: ScoredPost): Result<Unit> {
        val t = targetOf(post)
        if (isMarked(Mark.Boosted, t.id)) {
            graph.toasts.show("You boosted this. Nostr boosts cannot be taken back from here.")
            return Result.success(Unit)
        }
        val key = "boost:${t.id}"
        if (inFlight.contains(key)) return Result.success(Unit)
        val signer = requireSigner() ?: return Result.failure(ActionCancelled())
        if (!inFlight.add(key)) return Result.success(Unit)
        setMark(signer.pubkey, Mark.Boosted, t.id)
        return try {
            val original = originalOf(t)
            val target = NoteLogic.Target(t.id, t.author, original?.kind ?: t.kind, relayHint(t))
            val event = signChecked(signer, NoteLogic.repostTemplate(target, original))
            val results = pool.publishDetailed(publishRelaysFor(signer.pubkey, t.author), event, PUBLISH_TIMEOUT_MS)
            if (results.none { it.ok }) throw IllegalStateException(NoteLogic.describePublish(results))
            graph.toasts.show("Boosted. ${NoteLogic.describePublish(results)}.")
            Result.success(Unit)
        } catch (e: CancellationException) {
            clearMark(signer.pubkey, Mark.Boosted, t.id)
            throw e
        } catch (e: Exception) {
            clearMark(signer.pubkey, Mark.Boosted, t.id)
            graph.toasts.show("Could not boost: ${e.message}", "Retry") { graph.scope.launch { boost(post) } }
            Result.failure(e)
        } finally {
            inFlight.remove(key)
        }
    }

    /** Whether the current reader already boosted this note here (the sheet then just says so). */
    suspend fun isBoosted(post: ScoredPost): Boolean = isMarked(Mark.Boosted, targetOf(post).id)

    // ─── Reply ───────────────────────────────────────────────────────────────

    /** A reply signed and ready, with where it goes. Kept by the composer so a retry does not sign again. */
    internal class SignedReply(val event: NostrEvent, val relays: List<String>)

    /** Sign a reply to [t] as [signer]. Throws [SignFailure] (or a fetch error) with the reason. */
    internal suspend fun signReply(signer: NostrSigner, t: NoteTarget, text: String): SignedReply {
        val original = originalOf(t)
        val hint = relayHint(t)
        val relays = publishRelaysFor(signer.pubkey, t.author)
        val template = if (original != null) {
            NoteLogic.replyTemplate(text, original.id, original.pubkey, original.tags, hint, signer.pubkey)
        } else {
            NoteLogic.replyTemplate(text, t.id, t.author, emptyList(), hint, signer.pubkey)
        }
        return SignedReply(signChecked(signer, template), relays)
    }

    internal suspend fun publishReply(signed: SignedReply, onResult: ((RelayResult, List<RelayResult>) -> Unit)? = null): List<RelayResult> =
        pool.publishDetailed(signed.relays, signed.event, PUBLISH_TIMEOUT_MS, onResult)

    /**
     * Sign and publish a reply. Failure messages are the web's ("… Nothing was
     * sent.", "No relay accepted your reply (0 of 3). …"); a reader who backs
     * out of connecting a signer gets [ActionCancelled].
     */
    suspend fun reply(post: ScoredPost, text: String): Result<Unit> {
        if (text.isBlank()) return Result.failure(IllegalArgumentException("Write your reply first."))
        val signer = requireSigner() ?: return Result.failure(ActionCancelled())
        val t = targetOf(post)
        val signed = try {
            signReply(signer, t, text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return Result.failure(IllegalStateException("${e.message} Nothing was sent."))
        }
        val results = publishReply(signed)
        if (results.none { it.ok }) {
            return Result.failure(IllegalStateException("No relay accepted your reply (0 of ${results.size}). ${firstError(results)}".trim()))
        }
        graph.toasts.show("Sent. ${NoteLogic.describePublish(results)}.")
        return Result.success(Unit)
    }

    internal fun firstError(results: List<RelayResult>): String =
        results.firstOrNull { it.error != null }?.error?.let { "Last error: $it." } ?: ""

    internal suspend fun loadDraft(pubkey: String, id: String): String? = runCatching { graph.records.getRaw(draftKey(pubkey, id)) }.getOrNull()
        ?.let { runCatching { relayJson.parseToJsonElement(it).let { e -> (e as? kotlinx.serialization.json.JsonPrimitive)?.content } }.getOrNull() }

    internal fun saveDraft(pubkey: String, id: String, text: String) {
        graph.scope.launch(Dispatchers.IO) {
            runCatching {
                if (text.isEmpty()) graph.records.delete(draftKey(pubkey, id)) else graph.records.putRaw(draftKey(pubkey, id), jsonQuote(text))
            }
        }
    }

    private fun draftKey(pubkey: String, id: String) = "reply-draft:$pubkey:$id"

    internal val graphRef: AppGraph get() = graph

    // ─── Zaps ────────────────────────────────────────────────────────────────

    /** Zap flows by note id: they outlive the sheet, so a receipt that lands later still marks the note. */
    internal val zaps = ConcurrentHashMap<String, ZapFlow>()

    internal fun zapFlow(post: ScoredPost): ZapFlow {
        val t = targetOf(post)
        val existing = zaps[t.id]
        if (existing != null && !existing.finished) return existing
        return ZapFlow(this, t).also { zaps[t.id] = it }
    }

    companion object {
        /** Relays that index kind 10002 and kind 0 widely. */
        val INDEXER_RELAYS = listOf("wss://purplepag.es", "wss://relay.damus.io", "wss://relay.primal.net")
        const val PUBLISH_TIMEOUT_MS = 8_000L
        const val FETCH_TIMEOUT_MS = 5_000L
        const val LIST_TIMEOUT_MS = 3_500L
        private const val LISTS_MAX = 1000
        /** A miss is asked again after this long; a relay may have been down. */
        private const val MISS_TTL_MS = 10 * 60_000L
        private const val MARKS_PREFIX = "noteactions:"

        internal fun marksView(s: NoteLogic.NoteState): Map<String, Set<Mark>> {
            val out = HashMap<String, MutableSet<Mark>>()
            s.liked.keys.forEach { out.getOrPut(it) { mutableSetOf() }.add(Mark.Liked) }
            s.boosted.keys.forEach { out.getOrPut(it) { mutableSetOf() }.add(Mark.Boosted) }
            s.zapped.keys.forEach { out.getOrPut(it) { mutableSetOf() }.add(Mark.Zapped) }
            return out
        }
    }
}
