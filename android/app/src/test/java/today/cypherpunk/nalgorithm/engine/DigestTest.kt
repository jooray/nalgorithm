package today.cypherpunk.nalgorithm.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.PostType
import java.time.ZoneOffset

/** lib/test/digest-notes, faithfulness, identity (digest part) and feedback tests. */
class DigestTest {
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

    private fun post(id: String, score: Double, createdAt: Long = 1000, content: String = "post $id", justification: String? = null) =
        scoredPost(id, score, author = a, content = content, createdAt = createdAt, justification = justification)

    @Test
    fun `source notes follow the digest prompt's order and cut`() {
        val posts = listOf(post("p1", 5.0), post("p2", 9.0), post("p3", 7.0, createdAt = 2000), post("p4", 7.0), post("p5", 1.0))
        val notes = DigestWriter.digestSourceNotes(posts, 3)
        assertEquals(listOf("p2", "p3", "p4"), notes.map { it.id })
        val prompt = DigestWriter.buildDigestMessages(DigestWriter.Options(posts = posts, userPrompt = "x", topN = 3, zone = ZoneOffset.UTC))[1].content
        val inPrompt = Regex("\\d\\. \\[Score: \\d+/10, [^\\]]+] [^:]+: post (p\\d)").findAll(prompt).map { it.groupValues[1] }.toList()
        assertEquals(notes.map { it.id }, inPrompt)
        assertEquals(listOf("p2", "p3", "p4", "p1", "p5"), DigestWriter.digestSourceNotes(posts).map { it.id })
    }

    @Test
    fun `source note fields, reason and truncation`() {
        val n = DigestWriter.digestSourceNotes(listOf(post("p1", 8.0, content = "x".repeat(2000), justification = "about bitcoin")), 5).single()
        assertEquals(1500, n.content.length)
        assertEquals("about bitcoin", n.reason)
        assertEquals(1, n.kind)
        assertEquals(a, n.pubkey)
        val bare = DigestWriter.digestSourceNotes(listOf(post("p2", 3.0)), 5).single()
        assertNull(bare.reason)
        assertNull(bare.relay)
    }

    @Test
    fun `a boost points at the original note`() {
        val boost = scoredPost("boost1", 6.0, type = PostType.Boost, author = a, createdAt = 1500, originalPost = EmbeddedPost("orig", b, "the original"), kind = 6)
        val n = DigestWriter.digestSourceNotes(listOf(boost), 5).single()
        assertEquals("orig", n.id)
        assertEquals(b, n.pubkey)
        assertEquals("the original", n.content)
        assertEquals(1500L, n.createdAt)
        assertNull(n.kind)
        assertTrue(DigestWriter.digestSourceNotes(emptyList(), 5).isEmpty())
    }

    @Test
    fun `selection folds boosts before cutting and leaves out fallback scores`() {
        val original = scoredPost("a", 9.0, createdAt = 1)
        val boost = scoredPost("b", 9.0, type = PostType.Boost, createdAt = 1, originalPost = EmbeddedPost("a", "x", "y"))
        val other = scoredPost("c", 8.0, createdAt = 1)
        val fallback = scoredPost("d", 8.0, createdAt = 1, defaultScore = true)
        assertEquals(listOf("a", "c"), DigestWriter.selectDigestPosts(listOf(original, boost, other, fallback), 2).map { it.id })
    }

    private fun user(forSpeech: Boolean = false, faithfulness: Boolean = true, digestPrompt: String? = null) =
        DigestWriter.buildDigestMessages(DigestWriter.Options(posts = listOf(scoredPost("a", 8.0, content = "hello")), userPrompt = "x", forSpeech = forSpeech, faithfulness = faithfulness, digestPrompt = digestPrompt))[1].content

    @Test
    fun `faithfulness rules follow the post list, the sign-off only for speech`() {
        val text = user()
        assertTrue(text.contains(DigestWriter.FAITHFULNESS_RULES))
        assertFalse(text.contains(DigestWriter.SPOKEN_SIGN_OFF))
        assertTrue(text.indexOf(DigestWriter.FAITHFULNESS_RULES) > text.indexOf("hello"))
        assertTrue(user(forSpeech = true).contains(DigestWriter.SPOKEN_SIGN_OFF))
        assertTrue(user(digestPrompt = "custom").contains(DigestWriter.FAITHFULNESS_RULES))
        assertFalse(user(forSpeech = true, faithfulness = false).contains(DigestWriter.FAITHFULNESS_RULES))
        assertFalse(user(forSpeech = true, faithfulness = false).contains(DigestWriter.SPOKEN_SIGN_OFF))
    }

    @Test
    fun `the reader's minutes replace the default length and stay an upper bound`() {
        val posts = listOf(scoredPost(a, 9.0, content = "A note worth hearing about."))
        val short = DigestWriter.buildDigestMessages(DigestWriter.Options(posts = posts, userPrompt = "x", targetMinutes = 3))[0].content
        assertTrue(short.contains("at most about 3 minutes of spoken content (roughly 500-600 words)"))
        assertTrue(short.contains("be shorter: never pad"))
        assertFalse(short.contains("about 6 minutes"))
        assertTrue(DigestWriter.buildDigestMessages(DigestWriter.Options(posts = posts, userPrompt = "x"))[0].content.contains("about 6 minutes of spoken content"))
        val custom = DigestWriter.buildDigestMessages(DigestWriter.Options(posts = posts, userPrompt = "x", targetMinutes = 3, systemPrompt = "My own host."))[0].content
        assertTrue(custom.startsWith("My own host."))
        assertEquals(950 to 1200, DigestWriter.digestWordRange(6))
        assertEquals(1600 to 2000, DigestWriter.digestWordRange(10))
        assertEquals(2400 to 3000, DigestWriter.digestWordRange(40))
    }

    @Test
    fun `the digest never contains hex for unresolved authors`() {
        val boost = scoredPost("e".repeat(64), 8.0, type = PostType.Boost, author = a, content = "", originalPost = EmbeddedPost("f".repeat(64), b, "hello"))
        val line = DigestWriter.formatPostForDigest(boost, 0, zone = ZoneOffset.UTC)
        assertTrue(line.contains("Boosted by someone you follow] Originally by someone you follow: hello"))
        val messages = DigestWriter.buildDigestMessages(DigestWriter.Options(posts = listOf(boost), userPrompt = "x"))
        assertFalse(Regex("[0-9a-f]{8}").containsMatchIn(messages[1].content))
    }

    @Test
    fun `clock time reads like en-US`() {
        assertEquals("12:13 AM", DigestWriter.clockTime(1700007200, ZoneOffset.UTC).replace('\u202F', ' '))
        assertEquals("10:13 PM", DigestWriter.clockTime(1700000000, ZoneOffset.UTC))
        assertEquals("12:00 PM", DigestWriter.clockTime(43200, ZoneOffset.UTC))
    }

    @Test
    fun `feedback rules become one labelled block after the learned preferences`() {
        assertEquals("", Feedback.prompt(emptyList()))
        assertNull(Feedback.withFeedback(null, emptyList()))
        assertEquals("likes relays", Feedback.withFeedback("  likes relays ", emptyList()))
        val text = Feedback.withFeedback("likes relays", listOf(FeedbackRule("less", "Price  is\nup again"), FeedbackRule("more", "A new relay release")))!!
        assertTrue(text.startsWith("likes relays\n\n=== Private feedback on specific notes ==="))
        assertTrue(text.contains("- Less like this: \"Price is up again\""))
        assertTrue(text.contains("- More like this: \"A new relay release\""))
        val many = (0 until Feedback.RULES_MAX + 5).map { FeedbackRule("less", "note $it") }
        assertEquals(Feedback.RULES_MAX, Feedback.prompt(many).lines().count { it.startsWith("- ") })
    }
}
