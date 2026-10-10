package today.cypherpunk.nalgorithm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nostrsignin.Bech32

/** web/src/feedback.ts: private, per-identity, never published. */
@Serializable
data class StoredRule(val kind: String, val excerpt: String, val noteId: String, val at: Long)

@Serializable
data class SavedNote(val id: String, val author: String, val content: String, val createdAt: Long, val savedAt: Long)

@Serializable
data class FeedbackState(
    val rules: List<StoredRule> = emptyList(),
    val hidden: List<String> = emptyList(),
    val muted: List<String> = emptyList(),
    val saved: List<SavedNote> = emptyList(),
    /** Rules changed here that the server has not confirmed yet (hosted). */
    val rulesPending: Boolean = false,
)

/** The record as written, in the web's shape (`v: 1`). An older record without `rulesPending` is pending if it has rules. */
@Serializable
internal data class StoredFeedback(
    val v: Int = 1,
    val rules: List<StoredRule> = emptyList(),
    val hidden: List<String> = emptyList(),
    val muted: List<String> = emptyList(),
    val saved: List<SavedNote> = emptyList(),
    val rulesPending: Boolean? = null,
) {
    fun toState(): FeedbackState? {
        if (v != 1) return null
        val rules = rules.filter { (it.kind == FeedbackRule.MORE || it.kind == FeedbackRule.LESS) }
        return FeedbackState(rules, hidden, muted, saved, rulesPending ?: rules.isNotEmpty())
    }

    companion object {
        fun of(s: FeedbackState) = StoredFeedback(1, s.rules, s.hidden, s.muted, s.saved, s.rulesPending)
    }
}

/** The pure parts of feedback.ts: limits, excerpts, filters. */
object FeedbackLogic {
    const val HIDDEN_MAX = 500
    const val SAVED_MAX = 100
    const val MUTED_MAX = 200
    /** lib/src/feedback.ts: how many rules reach the model, newest first. */
    const val RULES_MAX = 20
    const val EXCERPT_MAX = 200

    private val NOSTR_REF = Regex("nostr:[a-z0-9]+", RegexOption.IGNORE_CASE)
    private val URL = Regex("https?://\\S+")
    private val SPACE = Regex("\\s+")

    /** A short excerpt of the note: what the model sees of the reader's reaction. */
    fun excerptOf(content: String): String {
        val text = content.replace(NOSTR_REF, "").replace(URL, "").replace(SPACE, " ").trim()
        return if (text.length > EXCERPT_MAX) text.take(EXCERPT_MAX - 1) + "…" else text
    }

    fun activeRules(state: FeedbackState): List<FeedbackRule> =
        state.rules.take(RULES_MAX).map { FeedbackRule(it.kind, it.excerpt) }

    /** Whether the reader asked not to see this note (itself, or its author's notes). */
    fun isFilteredOut(post: ScoredPost, state: FeedbackState): Boolean =
        post.id in state.hidden || post.author in state.muted || (post.originalPost?.author?.let { it in state.muted } ?: false)

    fun capped(s: FeedbackState): FeedbackState = s.copy(
        hidden = s.hidden.takeLast(HIDDEN_MAX),
        muted = s.muted.takeLast(MUTED_MAX),
        saved = s.saved.take(SAVED_MAX),
    )

    internal fun <T> insertAt(list: List<T>, index: Int, item: T): List<T> =
        list.take(index) + item + list.drop(index)
}

/**
 * The state machine of feedback.ts without storage or Android, so it can be
 * tested: one state per identity key, [persist] for every write and
 * [onRulesChanged] after the more/less rules change (hosted: send them).
 *
 * Every action returns its own undo. An undo reverses only its own action, for
 * the identity it was made under: an Undo still on screen after a sign-out or an
 * identity change does nothing, and undoing a repeated hide or mute does not lift
 * the earlier, deliberate one.
 */
class FeedbackEngine(
    private val persist: (key: String, state: FeedbackState) -> Unit,
    private val onRulesChanged: (List<FeedbackRule>) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val states = HashMap<String, FeedbackState>()
    /** Identities written here before their stored copy finished loading: the load must not overwrite them. */
    private val touched = HashSet<String>()
    private val _state = MutableStateFlow(FeedbackState())
    val state: StateFlow<FeedbackState> = _state.asStateFlow()

    var key: String? = null
        private set

    @Synchronized
    fun select(key: String?) {
        this.key = key
        _state.value = key?.let { states[it] } ?: FeedbackState()
    }

    fun has(key: String): Boolean = synchronized(this) { key in states || key in touched }

    /** The stored copy of [key] arrived. Ignored when this identity was already changed on this device meanwhile. */
    @Synchronized
    fun loaded(key: String, state: FeedbackState?) {
        if (key in touched) return
        states[key] = state ?: FeedbackState()
        if (this.key == key) _state.value = states.getValue(key)
    }

    fun read(): FeedbackState = synchronized(this) { key?.let { states[it] } ?: FeedbackState() }

    @Synchronized
    private fun write(next: FeedbackState, rulesChanged: Boolean) {
        val k = key ?: return
        var s = FeedbackLogic.capped(next)
        if (rulesChanged) s = s.copy(rulesPending = true)
        states[k] = s
        touched += k
        _state.value = s
        persist(k, s)
        if (rulesChanged) onRulesChanged(FeedbackLogic.activeRules(s))
    }

    private fun update(rulesChanged: Boolean = false, change: (FeedbackState) -> FeedbackState) {
        write(change(read()), rulesChanged)
    }

    /** Runs [undo] only while the identity that made the change is still the current one. */
    private fun sameIdentity(undo: () -> Unit): () -> Unit {
        val made = key
        return { if (made != null && key == made) undo() }
    }

    fun activeRules(): List<FeedbackRule> = FeedbackLogic.activeRules(read())

    /** Null when the note has no words to learn from. */
    fun addRule(kind: String, noteId: String, content: String): (() -> Unit)? {
        val excerpt = FeedbackLogic.excerptOf(content)
        if (excerpt.isEmpty()) return null
        val before = read().rules
        val index = before.indexOfFirst { it.noteId == noteId }
        val prior = before.getOrNull(index)
        update(rulesChanged = true) { s ->
            s.copy(rules = listOf(StoredRule(kind, excerpt, noteId, now())) + s.rules.filter { it.noteId != noteId })
        }
        return sameIdentity {
            update(rulesChanged = true) { s ->
                var rules = s.rules.filter { it.noteId != noteId }
                if (prior != null) rules = FeedbackLogic.insertAt(rules, index, prior)
                s.copy(rules = rules)
            }
        }
    }

    fun removeRule(noteId: String): () -> Unit {
        val before = read().rules
        val index = before.indexOfFirst { it.noteId == noteId }
        if (index < 0) return {}
        val removed = before[index]
        update(rulesChanged = true) { s -> s.copy(rules = s.rules.filter { it.noteId != noteId }) }
        return sameIdentity {
            update(rulesChanged = true) { s ->
                if (s.rules.any { it.noteId == noteId }) s
                else s.copy(rules = FeedbackLogic.insertAt(s.rules, index.coerceAtMost(s.rules.size), removed))
            }
        }
    }

    /**
     * Reconcile with the rules the server ranks with. Rules changed on this device that the
     * server has not confirmed are sent; otherwise the server's list wins, so a rule removed on
     * another device is not brought back from here.
     */
    fun adoptRules(rules: List<FeedbackRule>) {
        if (key == null) return
        val s = read()
        val server = rules.map { FeedbackRule(it.kind, it.excerpt) }
        val same = FeedbackLogic.activeRules(s) == server
        if (s.rulesPending) {
            if (same) markRulesSynced(server) else onRulesChanged(FeedbackLogic.activeRules(s))
            return
        }
        if (same) return
        write(
            s.copy(
                rules = rules.mapIndexed { i, r -> StoredRule(r.kind, r.excerpt, "server-$i", 0) },
                rulesPending = false,
            ),
            rulesChanged = false,
        )
    }

    /** The server stored these rules; nothing is pending if they are still what this device has. */
    @Synchronized
    fun markRulesSynced(rules: List<FeedbackRule>) {
        val k = key ?: return
        val s = read()
        if (!s.rulesPending || FeedbackLogic.activeRules(s) != rules.map { FeedbackRule(it.kind, it.excerpt) }) return
        val next = s.copy(rulesPending = false)
        states[k] = next
        touched += k
        _state.value = next
        persist(k, next)
    }

    fun hideNote(id: String): () -> Unit {
        if (id in read().hidden) return {}
        update { s -> s.copy(hidden = s.hidden + id) }
        return sameIdentity { update { s -> s.copy(hidden = s.hidden.filter { it != id }) } }
    }

    fun showHiddenNotes(): () -> Unit {
        val before = read().hidden
        update { s -> s.copy(hidden = emptyList()) }
        return sameIdentity { update { s -> s.copy(hidden = before + s.hidden.filter { it !in before }) } }
    }

    fun muteAuthor(pubkey: String): () -> Unit {
        if (pubkey in read().muted) return {}
        update { s -> s.copy(muted = s.muted + pubkey) }
        return sameIdentity { unmuteAuthor(pubkey) }
    }

    fun unmuteAuthor(pubkey: String) {
        update { s -> s.copy(muted = s.muted.filter { it != pubkey }) }
    }

    fun isSaved(id: String): Boolean = read().saved.any { it.id == id }

    fun saveNote(id: String, author: String, content: String, createdAt: Long): () -> Unit {
        if (isSaved(id)) return {}
        update { s -> s.copy(saved = listOf(SavedNote(id, author, content, createdAt, now())) + s.saved.filter { it.id != id }) }
        return sameIdentity { unsaveNote(id) }
    }

    fun unsaveNote(id: String) {
        update { s -> s.copy(saved = s.saved.filter { it.id != id }) }
    }

    /** "Clear this device": nothing of anyone's feedback stays in memory. */
    @Synchronized
    fun forgetAll() {
        states.clear()
        touched.clear()
        _state.value = FeedbackState()
    }
}

/**
 * Private feedback on notes: More / Less like this, hiding a note, hiding a
 * person's notes, saving a note for later. Kept per identity in [RecordStore]
 * (`feedback:<hex>`); the more/less rules also steer ranking, so every change
 * of them goes to the active mode ([ModeController.onFeedbackRulesChanged]).
 */
class FeedbackStore(private val graph: AppGraph) {
    private val writes = Mutex()
    private val engine = FeedbackEngine(
        persist = { key, state ->
            graph.scope.launch {
                writes.withLock { graph.records.put(RECORD_PREFIX + key, StoredFeedback.serializer(), StoredFeedback.of(state)) }
            }
        },
        onRulesChanged = { rules -> graph.active?.onFeedbackRulesChanged(rules) },
    )

    val state: StateFlow<FeedbackState> = engine.state

    /** Whose feedback is in effect (the active mode's reader); loads it from the device. */
    fun setIdentity(pubkeyHex: String?) {
        val key = pubkeyHex?.let { Bech32.pubkeyHex(it) }
        if (key == engine.key) return
        engine.select(key)
        if (key == null || engine.has(key)) return
        graph.scope.launch {
            val stored = runCatching { graph.records.get(RECORD_PREFIX + key, StoredFeedback.serializer()) }.getOrNull()
            engine.loaded(key, stored?.toState())
        }
    }

    /** The rules that steer ranking, newest first, capped like lib's FEEDBACK_RULES_MAX. */
    fun rules(): List<FeedbackRule> = engine.activeRules()

    /** Hosted: rules from the server replace the local ones unless local changes are pending. */
    fun adoptRules(rules: List<FeedbackRule>) = engine.adoptRules(rules)

    /** Hosted: the server confirmed these rules. */
    fun markRulesSynced(rules: List<FeedbackRule>) = engine.markRulesSynced(rules)

    fun addRule(kind: String, post: ScoredPost): (() -> Unit)? = engine.addRule(kind, post.id, post.content)
    fun removeRule(noteId: String): () -> Unit = engine.removeRule(noteId)
    fun hideNote(id: String): () -> Unit = engine.hideNote(id)
    fun showHiddenNotes(): () -> Unit = engine.showHiddenNotes()
    fun muteAuthor(pubkey: String): () -> Unit = engine.muteAuthor(pubkey)
    fun unmuteAuthor(pubkey: String) = engine.unmuteAuthor(pubkey)
    fun isSaved(id: String): Boolean = engine.isSaved(id)
    fun saveNote(post: ScoredPost): () -> Unit = engine.saveNote(post.id, post.author, post.content, post.createdAt)
    fun unsaveNote(id: String) = engine.unsaveNote(id)
    fun isFilteredOut(post: ScoredPost): Boolean = FeedbackLogic.isFilteredOut(post, state.value)

    /** "Clear this device" wiped the records; drop the copies held in memory. */
    fun forgetAll() = engine.forgetAll()

    companion object {
        const val RECORD_PREFIX = "feedback:"
    }
}
