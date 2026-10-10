package today.cypherpunk.nalgorithm.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost

/** Port of web/test/identity.test.mjs. */
class IdentityTest {
    private fun pk(c: Char) = c.toString().repeat(64)
    private fun note(id: String, author: String, score: Double = 5.0, justification: String? = null, createdAt: Long = 100) =
        ScoredPost(id, PostType.Original, author, "note $id", createdAt, score = score, justification = justification)
    private fun boost(id: String, booster: String, orig: String, createdAt: Long = 200, score: Double = 5.0, justification: String? = null) =
        ScoredPost(id, PostType.Boost, booster, "", createdAt, originalPost = EmbeddedPost(orig, pk('9'), "orig $orig"), score = score, justification = justification)

    @Test
    fun `a boost folds into the original when both are in the list`() {
        val out = aggregateBoosts(listOf(boost("b1", pk('a'), "n1"), note("n1", pk('9'))))
        assertEquals(1, out.size)
        assertEquals("n1", out[0].id)
        assertEquals(PostType.Original, out[0].post.type)
        assertEquals(pk('9'), out[0].post.author)
        assertEquals("the note keeps its own time", 100L, out[0].post.createdAt)
        assertEquals(listOf(pk('a')), out[0].boostedBy)
    }

    @Test
    fun `original first, then boosts`() {
        val out = aggregateBoosts(listOf(note("n1", pk('9')), boost("b1", pk('a'), "n1"), boost("b2", pk('b'), "n1")))
        assertEquals(1, out.size)
        assertEquals(listOf(pk('a'), pk('b')), out[0].boostedBy)
    }

    @Test
    fun `several boosts without the original become one card from the embedded original`() {
        val out = aggregateBoosts(listOf(boost("b1", pk('a'), "n1", 300), boost("b2", pk('b'), "n1", 500), boost("b3", pk('c'), "n1", 400)))
        assertEquals(1, out.size)
        val p = out[0].post
        assertEquals(pk('9'), p.author)
        assertEquals("orig n1", p.content)
        assertEquals("n1", p.id)
        assertEquals(PostType.Original, p.type)
        assertEquals("latest boost stands in for the missing note time", 500L, p.createdAt)
        assertEquals(listOf(pk('a'), pk('b'), pk('c')), out[0].boostedBy)
    }

    @Test
    fun `highest score and its justification win and a raised score re-sorts`() {
        val out = aggregateBoosts(listOf(note("x", pk('1'), 7.0), note("n1", pk('9'), 3.0, "low"), boost("b1", pk('a'), "n1", score = 9.0, justification = "high")))
        assertEquals(listOf("n1", "x"), out.map { it.id })
        assertEquals(9.0, out[0].post.score, 0.0)
        assertEquals("high", out[0].post.justification)
    }

    @Test
    fun `order is untouched when no score is raised`() {
        val out = aggregateBoosts(listOf(note("a", pk('1'), 9.0), note("b", pk('2'), 5.0), boost("b1", pk('c'), "b", score = 2.0)))
        assertEquals(listOf("a", "b"), out.map { it.id })
    }

    @Test
    fun `quotes stay, and a boost of a quote folds into the quote`() {
        val quote = ScoredPost("q1", PostType.Quote, pk('1'), "my take", 1, quotedPost = EmbeddedPost("n1", pk('9'), "x"))
        val out = aggregateBoosts(listOf(quote, note("n1", pk('9'))))
        assertEquals(2, out.size)
        assertTrue(out[0].boostedBy.isEmpty())
        val folded = aggregateBoosts(listOf(quote, boost("b1", pk('a'), "q1")))
        assertEquals(1, folded.size)
        assertEquals(PostType.Quote, folded[0].post.type)
        assertEquals(listOf(pk('a')), folded[0].boostedBy)
    }

    @Test
    fun `duplicate boosters and notes collapse`() {
        val out = aggregateBoosts(listOf(note("n1", pk('9')), note("n1", pk('9')), boost("b1", pk('a'), "n1"), boost("b2", pk('a'), "n1")))
        assertEquals(1, out.size)
        assertEquals(listOf(pk('a')), out[0].boostedBy)
    }

    @Test
    fun `a boost whose original is unresolved stays a plain entry`() {
        val b = ScoredPost("b1", PostType.Boost, pk('a'), "", 1, score = 1.0)
        val out = aggregateBoosts(listOf(b, note("n1", pk('9')), boost("b2", pk('c'), "n1")))
        assertEquals(2, out.size)
        assertTrue(out[0].boostedBy.isEmpty())
    }

    @Test
    fun `summarizeBoosters shows four in full, else three and the rest`() {
        val ks = "123456".map(::pk)
        assertEquals(ks.take(4) to emptyList<String>(), summarizeBoosters(ks.take(4)))
        assertEquals(ks.take(3) to ks.drop(3), summarizeBoosters(ks))
    }

    @Test
    fun `author label - name when known, full npub otherwise, never hex`() {
        val key = pk('a')
        assertEquals(AuthorLabel("Alice", false), authorLabel(key, ProfileData(key, name = "Alice")))
        val unknown = authorLabel(key, null)
        assertTrue(unknown.isNpub)
        assertTrue(unknown.text.startsWith("npub1") && unknown.text.length > 60)
        assertFalse(Regex("[0-9a-f]{64}").containsMatchIn(unknown.text))
        assertTrue("a name that is a bare key does not count", authorLabel(key, ProfileData(key, name = pk('b'))).isNpub)
        assertEquals("invalid key yields nothing, not hex", "", authorLabel("not a key", null).text)
    }

    @Test
    fun `avatar initial comes from the name, never from a key`() {
        assertEquals("A", avatarInitial(ProfileData("x", name = "alice")))
        assertEquals("B", avatarInitial(ProfileData("x", name = "  ⚡ bob")))
        assertEquals("?", avatarInitial(null))
        assertEquals("?", avatarInitial(ProfileData("x", name = pk('f'))))
        assertNull(profileName(ProfileData("x", name = " ")))
    }

    @Test
    fun `npub and nprofile match NIP-19 and keep at most three relay hints`() {
        val key = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
        assertEquals("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6", NoteIds.npub(key))
        assertEquals(
            "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p",
            NoteIds.nprofile(key, listOf("wss://r.x.com", "wss://djbas.sadkb.com")),
        )
        val relays = listOf("wss://a.example", "wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example", "javascript:x")
        val np = NoteIds.nprofile(pk('a'), relays)
        assertEquals(pk('a'), NoteIds.pubkeyOfProfileRef(np))
        assertEquals(listOf("wss://a.example", "wss://b.example", "wss://c.example"), NoteIds.relaysOf(np))
        assertEquals("no relays, no invented hints", emptyList<String>(), NoteIds.relaysOf(NoteIds.nprofile(pk('a'))))
        assertEquals(pk('a'), NoteIds.pubkeyOfProfileRef(NoteIds.npub(pk('a'))))
    }

    @Test
    fun `nevent carries the id, author and kind`() {
        val nevent = NoteIds.nevent(pk('c'), pk('a'), 1, listOf("wss://r.example"))
        assertTrue(nevent.startsWith("nevent1"))
        assertEquals(pk('c'), NoteIds.eventIdOf(nevent))
        assertEquals(listOf("wss://r.example"), NoteIds.relaysOf(nevent))
        assertEquals("", NoteIds.nevent("not-an-id"))
    }

    @Test
    fun `tokenizeContent finds mentions, refs and urls - text stays text`() {
        val npub = NoteIds.npub(pk('a'))
        val nprofile = NoteIds.nprofile(pk('b'))
        val nevent = NoteIds.nevent(pk('c'))
        val tokens = tokenizeContent("<b>hi</b> nostr:$npub and nostr:$nprofile, see nostr:$nevent (https://example.com/x) end")
        assertEquals(
            listOf("Text", "Profile", "Text", "Profile", "Text", "Ref", "Text", "Url", "Text"),
            tokens.map { it::class.simpleName },
        )
        assertEquals("<b>hi</b> ", (tokens[0] as ContentToken.Text).text)
        assertEquals(pk('a'), (tokens[1] as ContentToken.Profile).pubkey)
        assertEquals(pk('b'), (tokens[3] as ContentToken.Profile).pubkey)
        assertEquals("https://example.com/x", (tokens[7] as ContentToken.Url).url)
        assertEquals(")", (tokens[7] as ContentToken.Url).trailing)
        assertNull(NoteIds.pubkeyOfProfileRef("npub1broken"))
    }

    @Test
    fun `people of a card include boosters, quoted authors and mentions`() {
        val p = ScoredPost("q", PostType.Quote, pk('1'), "hi nostr:${NoteIds.npub(pk('2'))}", 1, quotedPost = EmbeddedPost("n", pk('3'), "x"))
        assertEquals(listOf(pk('1'), pk('4'), pk('3'), pk('2')), peopleOf(DisplayPost(p, listOf(pk('4')))))
    }

    @Test
    fun `short names and handles`() {
        assertEquals("Bob", shortName(pk('a'), ProfileData(pk('a'), name = "Bob")))
        val s = shortName(pk('a'), null)
        assertTrue(s.startsWith("npub1") && s.contains("…") && s.length == 17)
        assertEquals("example.com", handleOf(ProfileData("x", nip05 = "_@example.com")))
        assertEquals("bob@example.com", handleOf(ProfileData("x", nip05 = " bob@example.com ")))
    }
}
