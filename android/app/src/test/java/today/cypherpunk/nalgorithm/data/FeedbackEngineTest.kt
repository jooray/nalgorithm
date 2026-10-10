package today.cypherpunk.nalgorithm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.model.EmbeddedPost

/** Port of web/test/feedback.test.mjs, against the storage-free engine. */
class FeedbackEngineTest {
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)
    private fun id(n: Int) = n.toString(16).padStart(64, '0')
    private fun content(n: Int) = "Note number $n about relays"

    private val persisted = mutableListOf<Pair<String, FeedbackState>>()
    private val synced = mutableListOf<List<FeedbackRule>>()
    private var clock = 1_000L
    private val engine = FeedbackEngine({ k, s -> persisted += k to s }, { synced += it }, { clock++ })

    @Test
    fun `hide, mute and undo are kept per identity`() {
        engine.select(a)
        val undoHide = engine.hideNote(id(1))
        val undoMute = engine.muteAuthor(b)
        val post3 = ScoredPost(id(3), PostType.Original, b, "x", 1)
        assertTrue(FeedbackLogic.isFilteredOut(post3, engine.state.value))
        undoMute(); undoHide()
        assertEquals(emptyList<String>(), engine.state.value.hidden)
        assertEquals(emptyList<String>(), engine.state.value.muted)
        engine.hideNote(id(2))
        engine.select(b)
        assertEquals("another identity has its own feedback", 0, engine.read().hidden.size)
        engine.select(a)
        assertEquals(listOf(id(2)), engine.read().hidden)
        assertTrue(persisted.all { it.first == a })
    }

    @Test
    fun `a boost of a muted author's note is filtered out too`() {
        engine.select(a)
        engine.muteAuthor(b)
        val boost = ScoredPost("x", PostType.Boost, a, "", 1, originalPost = EmbeddedPost("y", b, "hi"))
        assertTrue(FeedbackLogic.isFilteredOut(boost, engine.state.value))
    }

    @Test
    fun `more and less rules are excerpts, one per note, newest first`() {
        engine.select(a)
        engine.addRule("less", "x", "Price is up again https://x.example nostr:npub1abc")
        val undo = engine.addRule("more", "y", "A relay release")!!
        engine.addRule("less", "y", "A relay release")
        assertEquals(listOf("less" to "A relay release", "less" to "Price is up again"), engine.activeRules().map { it.kind to it.excerpt })
        assertEquals("each change is offered to the server sync", 3, synced.size)
        assertNull("a note without words teaches nothing", engine.addRule("more", "z", "https://only.a.link"))
        undo()
        assertEquals("undo restores the rules as they were before that action", listOf("less"), engine.activeRules().map { it.kind })
    }

    @Test
    fun `an undo reverses only its own action, for the identity that made it`() {
        engine.select(a)
        val undoRule = engine.addRule("more", id(1), content(1))!!
        engine.select(b)
        engine.addRule("less", id(2), content(2))
        undoRule()
        assertEquals(listOf("less"), engine.read().rules.map { it.kind })
        engine.select(a)
        assertEquals(1, engine.read().rules.size)

        engine.muteAuthor(b)
        engine.muteAuthor(b)()
        assertEquals("undoing a repeated mute keeps the deliberate one", listOf(b), engine.read().muted)
        engine.hideNote(id(3))
        engine.hideNote(id(3))()
        assertEquals(listOf(id(3)), engine.read().hidden)

        val undoLater = engine.addRule("less", id(4), content(4))!!
        engine.addRule("more", id(5), content(5))
        undoLater()
        assertEquals("a later rule survives an earlier undo", listOf(id(5), id(1)), engine.read().rules.map { it.noteId })
    }

    @Test
    fun `rules sync - local changes are sent until confirmed, then the server list wins`() {
        engine.select(a)
        engine.addRule("more", id(1), content(1))
        val mine = synced.last()
        engine.adoptRules(emptyList())
        assertEquals("an unconfirmed local rule is sent again, not dropped", mine, synced.last())
        assertEquals(1, engine.read().rules.size)
        engine.markRulesSynced(mine)
        assertFalse(engine.read().rulesPending)
        engine.adoptRules(emptyList())
        assertEquals("once confirmed, a removal made on another device sticks", 0, engine.read().rules.size)
        engine.adoptRules(listOf(FeedbackRule("less", "price talk")))
        assertEquals("a new device takes the server list", listOf(FeedbackRule("less", "price talk")), engine.activeRules())
    }

    @Test
    fun `removing the last rule here is sent, not replaced by the server list`() {
        engine.select(a)
        engine.addRule("more", id(1), content(1))
        engine.markRulesSynced(synced.last())
        engine.removeRule(id(1))
        engine.adoptRules(listOf(FeedbackRule("more", FeedbackLogic.excerptOf(content(1)))))
        assertEquals(0, engine.read().rules.size)
        assertEquals(emptyList<FeedbackRule>(), synced.last())
    }

    @Test
    fun `limits cap what is kept`() {
        engine.select(a)
        repeat(FeedbackLogic.HIDDEN_MAX + 5) { engine.hideNote("h$it") }
        assertEquals(FeedbackLogic.HIDDEN_MAX, engine.read().hidden.size)
        assertEquals("the oldest hides go first", "h5", engine.read().hidden.first())
        repeat(FeedbackLogic.SAVED_MAX + 3) { engine.saveNote("s$it", a, "c", 1) }
        assertEquals(FeedbackLogic.SAVED_MAX, engine.read().saved.size)
        assertEquals("newest saved first", "s${FeedbackLogic.SAVED_MAX + 2}", engine.read().saved.first().id)
        repeat(30) { engine.addRule("more", "r$it", "rule $it") }
        assertEquals(FeedbackLogic.RULES_MAX, engine.activeRules().size)
        assertEquals(30, engine.read().rules.size)
    }

    @Test
    fun `excerpts drop links and references and are capped`() {
        assertEquals("Look here", FeedbackLogic.excerptOf("  Look   https://a.example/x\nhere nostr:nevent1qqq "))
        val long = FeedbackLogic.excerptOf("w".repeat(500))
        assertEquals(FeedbackLogic.EXCERPT_MAX, long.length)
        assertTrue(long.endsWith("…"))
    }

    @Test
    fun `save, unsave, show hidden notes with undo`() {
        engine.select(a)
        val undoSave = engine.saveNote(id(1), b, "keep", 5)
        assertTrue(engine.isSaved(id(1)))
        undoSave()
        assertFalse(engine.isSaved(id(1)))
        engine.hideNote("x"); engine.hideNote("y")
        val undo = engine.showHiddenNotes()
        assertEquals(0, engine.read().hidden.size)
        engine.hideNote("z")
        undo()
        assertEquals(listOf("x", "y", "z"), engine.read().hidden)
    }

    @Test
    fun `nothing is written without an identity, and a late load does not overwrite local changes`() {
        engine.select(null)
        engine.hideNote("x")
        assertTrue(persisted.isEmpty())
        engine.select(a)
        engine.hideNote("mine")
        engine.loaded(a, FeedbackState(hidden = listOf("old")))
        assertEquals(listOf("mine"), engine.read().hidden)
        engine.loaded(b, FeedbackState(hidden = listOf("theirs")))
        engine.select(b)
        assertEquals(listOf("theirs"), engine.state.value.hidden)
    }

    @Test
    fun `stored records read like the web's, older ones pending when they have rules`() {
        val old = StoredFeedback(rules = listOf(StoredRule("more", "x", "n", 1), StoredRule("bogus", "y", "m", 2)))
        val state = old.toState()!!
        assertEquals(1, state.rules.size)
        assertTrue(state.rulesPending)
        assertNull(StoredFeedback(v = 2).toState())
    }
}
