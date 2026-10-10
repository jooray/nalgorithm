package today.cypherpunk.nalgorithm.ui.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.data.FeedbackState
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost

class FeedLogicTest {
    private fun pk(c: Char) = c.toString().repeat(64)
    private fun note(id: String, author: String = pk('1'), score: Double = 5.0, isNew: Boolean = false, defaultScore: Boolean = false) =
        ScoredPost(id, PostType.Original, author, "text $id", 1, score = score, isNew = isNew, defaultScore = defaultScore)

    @Test
    fun `age label`() {
        assertEquals("", FeedLogic.ageLabel(null, 1000))
        assertEquals("Updated just now", FeedLogic.ageLabel(1000, 1030))
        assertEquals("Updated 12 min ago", FeedLogic.ageLabel(1000, 1000 + 12 * 60))
        assertEquals("Updated 3 h ago", FeedLogic.ageLabel(0, 3 * 3600))
        assertEquals("Updated 47 h ago", FeedLogic.ageLabel(0, 47 * 3600))
        assertEquals("Updated 2 d ago", FeedLogic.ageLabel(0, 48 * 3600))
        assertEquals("Updated just now", FeedLogic.ageLabel(2000, 1000))
    }

    @Test
    fun `pill label`() {
        assertEquals("1 new note", FeedLogic.pillLabel(1))
        assertEquals("4 new notes", FeedLogic.pillLabel(4))
    }

    @Test
    fun `split fresh only when it sets something apart`() {
        val ids = listOf("a", "b", "c")
        assertEquals(listOf("b") to listOf("a", "c"), FeedLogic.splitFresh(ids, setOf("b")) { it })
        assertEquals(emptyList<String>() to ids, FeedLogic.splitFresh(ids, setOf("a", "b", "c")) { it })
        assertEquals(emptyList<String>() to ids, FeedLogic.splitFresh(ids, emptySet()) { it })
    }

    @Test
    fun `layout folds boosts, applies private hides and puts fresh notes first`() {
        val posts = listOf(
            note("a", score = 9.0),
            note("b", score = 7.0),
            ScoredPost("bx", PostType.Boost, pk('2'), "", 2, originalPost = EmbeddedPost("c", pk('3'), "orig"), score = 6.0),
            note("d", author = pk('m'), score = 5.0),
            note("e", score = 4.0, isNew = true),
        )
        val feedback = FeedbackState(hidden = listOf("b"), muted = listOf(pk('m')))
        val newFirst = FeedLogic.layout(posts, fresh = listOf("c"), feedOrder = "new", feedback = feedback)
        assertEquals(listOf("c", "e"), newFirst.fresh.map { it.id })
        assertEquals(listOf("a"), newFirst.rest.map { it.id })
        assertEquals(listOf(pk('2')), newFirst.fresh[0].boostedBy)
        assertEquals("a", newFirst.topId)

        val best = FeedLogic.layout(posts, fresh = listOf("c"), feedOrder = "best", feedback = feedback)
        assertTrue(best.fresh.isEmpty())
        assertEquals(listOf("a", "c", "e"), best.rest.map { it.id })
    }

    @Test
    fun `everything hidden is told apart from an empty feed`() {
        val all = FeedLogic.layout(listOf(note("a")), emptyList(), "new", FeedbackState(hidden = listOf("a")))
        assertTrue(all.allHidden)
        val none = FeedLogic.layout(emptyList(), emptyList(), "new", FeedbackState())
        assertEquals(false, none.allHidden)
    }

    @Test
    fun `the lime edge goes to the first best ranked note, never an unranked one`() {
        val top = FeedLogic.layout(listOf(note("u", score = 10.0, defaultScore = true), note("a", score = 8.0), note("b", score = 8.0)), emptyList(), "best", FeedbackState())
        assertEquals("a", top.topId)
    }
}
