package today.cypherpunk.nalgorithm.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData

class RankerParsingTest {
    private fun scores(raw: String, n: Int = 3) = Scoring.validateScoreResponse(raw, n).scores.map { Triple(it.index.toInt(), it.score, it.justification) }

    @Test
    fun `the documented tuple array`() {
        assertEquals(
            listOf(Triple(1, 8.0, "relays"), Triple(2, 2.0, "meme"), Triple(3, 0.0, "spam")),
            scores("""[[1, 8, "relays"], [2, 2, "meme"], [3, 0, "spam"]]"""),
        )
        assertNull(Scoring.validateScoreResponse("""[[1, 8, "a"]]""", 1).error)
    }

    @Test
    fun `fences, prose and think blocks around the JSON`() {
        assertEquals(listOf(Triple(1, 7.0, "x")), scores("Sure!\n```json\n[[1, 7, \"x\"]]\n```\nDone", 1))
        assertEquals(listOf(Triple(1, 6.0, "y")), scores("<think>[[9,9,\"no\"]] hmm</think>[[1, 6, \"y\"]]", 1))
        assertEquals(listOf(Triple(1, 5.0, "")), scores("Here you go: [[1, 5]] hope it helps", 1))
    }

    @Test
    fun `object shapes models drift into`() {
        assertEquals(
            listOf(Triple(1, 9.0, "a"), Triple(2, 3.0, "b")),
            scores("""{"scores": [{"post_number": 1, "score": 9, "justification": "a"}, {"index": 2, "rating": "3", "reason": "b"}]}""", 2),
        )
        // Keyed by post number, with tuple values: not mistaken for a wrapper.
        assertEquals(listOf(Triple(1, 9.0, "x"), Triple(2, 4.0, "")), scores("""{"1": [1, 9, "x"], "2": {"score": 4}}""", 2))
        // A bare list of scores takes positions.
        assertEquals(listOf(Triple(1, 4.0, ""), Triple(2, 6.0, "")), scores("[4, 6]", 2))
        // [score, justification]
        assertEquals(listOf(Triple(1, 7.0, "why")), scores("""[[7, "why"]]""", 1))
    }

    @Test
    fun `scores are clamped, strings parse like parseInt`() {
        assertEquals(listOf(Triple(1, 10.0, ""), Triple(2, 0.0, ""), Triple(3, 8.0, "")), scores("""[[1, 14], [2, -3], {"post_number": 3, "score": "8/10"}]"""))
    }

    @Test
    fun `a truncated response keeps the entries before the cut`() {
        val r = Scoring.validateScoreResponse("""[[1, 8, "good"], [2, 3, "meh"], [3, 9, "trunc""", 3)
        assertEquals(listOf(1, 2), r.scores.map { it.index.toInt() })
        assertTrue(r.error!!.startsWith("Salvaged 2 entries"))
        val objects = Scoring.validateScoreResponse("""{"a": [{"post_number": 1, "score": 4}, {"post_number": 2, "sc""", 2)
        assertEquals(listOf(1), objects.scores.map { it.index.toInt() })
    }

    @Test
    fun `out of range and unrecognized entries are reported, the rest kept`() {
        val r = Scoring.validateScoreResponse("""[[1, 8, "a"], [7, 2, "b"], "junk"]""", 2)
        assertEquals(listOf(1), r.scores.map { it.index.toInt() })
        assertTrue(r.error!!.contains("Index out of range: 7 (expected 1-2)"))
        assertTrue(r.error!!.contains("Unrecognized entry: \"junk\""))
        assertEquals("Failed to parse LLM response as JSON", Scoring.validateScoreResponse("no json here", 2).error)
        assertEquals("LLM response contained no recognizable score entries", Scoring.validateScoreResponse("[]", 2).error)
        // An object that is no entry is salvaged, then refused, like the library does.
        assertEquals("No valid scores parsed. Errors: Unrecognized entry: {\"ok\":true}", Scoring.validateScoreResponse("""{"ok": true}""", 2).error)
        assertTrue(Scoring.validateScoreResponse("[[9, 1]]", 2).error!!.startsWith("No valid scores parsed. Errors: Index out of range"))
    }

    @Test
    fun `prompt formatting - numbers, names, no keys, refs stripped, truncated`() {
        val author = "b".repeat(64)
        val boost = fetchedPost("x", PostType.Boost, author = author, originalPost = EmbeddedPost("o", "c".repeat(64), "see nostr:note1abc\n\nwow"))
        assertEquals("1. [Boosted by an unknown author] \"see [referenced post] wow\"", Scoring.formatPostForPrompt(boost, 0, null))
        val quote = fetchedPost("q", PostType.Quote, author = author, content = "agree", quotedPost = EmbeddedPost("o", "c", "x".repeat(400)))
        val line = Scoring.formatPostForPrompt(quote, 1, mapOf(author to ProfileData(author, name = "Bob")))
        assertTrue(line.startsWith("2. [Quote by Bob] \"agree\" — Quoted post: \"" + "x".repeat(300) + "...\""))
        val prompt = Scoring.buildUserPrompt(listOf(boost), "Bitcoin", "  ", null)
        assertFalse(prompt.contains("Learned Preferences"))
        assertTrue(prompt.endsWith("Score all 1 posts. Respond with JSON only."))
        assertTrue(Scoring.buildUserPrompt(listOf(boost), "Bitcoin", "likes relays", null).contains("=== Learned Preferences (from user behavior) ===\nlikes relays"))
    }

    @Test
    fun `decision helpers`() {
        assertEquals(10.0, Scoring.decisionScore(5.0), 0.0)
        assertEquals(6.67, Scoring.decisionScore(3.333), 0.0)
        assertEquals(0.0, Scoring.decisionScore(-1.0), 0.0)
        assertEquals(
            "74% clearly relevant to one of the user's interests, with reasonable depth or insight; 20% directly about a core interest of the user, substantive, high signal",
            Scoring.describeDistribution(mapOf("4" to 0.74, "5" to 0.2, "3" to 0.06)),
        )
        assertTrue(Scoring.failsEveryBatch(ProviderError(401, "x")))
        assertTrue(Scoring.failsEveryBatch(ProviderBusy()))
        assertFalse(Scoring.failsEveryBatch(ProviderError(400, "x")))
        assertFalse(Scoring.failsEveryBatch(Exception("network")))
    }

    @Test
    fun `boosts score under the boosted note, quotes under their own id`() {
        val boost = fetchedPost("b1", PostType.Boost, originalPost = EmbeddedPost("orig", "x", "y"))
        assertEquals("orig", Scoring.scoreCacheKey(boost))
        assertEquals("q", Scoring.scoreCacheKey(fetchedPost("q", PostType.Quote, quotedPost = EmbeddedPost("o", "x", "y"))))
        assertEquals("b2", Scoring.scoreCacheKey(fetchedPost("b2", PostType.Boost)))
    }

    @Test
    fun `relevance order puts fallback scores last, then newest first on ties`() {
        val sorted = Scoring.sortByRelevance(
            listOf(
                scoredPost("d", 9.0, defaultScore = true),
                scoredPost("a", 5.0, createdAt = 1),
                scoredPost("b", 5.0, createdAt = 2),
                scoredPost("c", 7.0),
            ),
        )
        assertEquals(listOf("c", "b", "a", "d"), sorted.map { it.id })
    }
}
