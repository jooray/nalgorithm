package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.nostr.Filter
import today.cypherpunk.nalgorithm.nostr.RelayPoolApi
import today.cypherpunk.nostrsignin.Bech32
import java.util.Collections

internal fun hexBytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
internal fun npub(hex: String) = Bech32.encode("npub", hexBytes(hex))
internal fun nprofile(hex: String, relay: String) = Bech32.encode("nprofile", byteArrayOf(0, 32) + hexBytes(hex) + byteArrayOf(1, relay.length.toByte()) + relay.toByteArray())
internal fun nevent(hex: String) = Bech32.encode("nevent", byteArrayOf(0, 32) + hexBytes(hex))

/** A fake pool: [serve] answers per relay; every call is logged. */
private class FakePool(val serve: (relay: String, filter: Filter) -> List<NostrEvent>) : RelayPoolApi {
    data class Call(val relays: List<String>, val filter: Filter)
    val calls: MutableList<Call> = Collections.synchronizedList(mutableListOf())
    override suspend fun query(relays: List<String>, filters: List<Filter>, timeoutMs: Long): List<NostrEvent> {
        val f = filters.single()
        calls.add(Call(relays, f))
        return relays.flatMap { serve(it, f) }
    }
    override suspend fun get(relays: List<String>, filter: Filter, timeoutMs: Long): NostrEvent? = null
    override suspend fun publish(relays: List<String>, event: NostrEvent, timeoutMs: Long): Map<String, Boolean> = emptyMap()
    override fun subscribe(relays: List<String>, filters: List<Filter>): Flow<NostrEvent> = emptyFlow()
}

/** lib/test/profiles.test.mjs and identity.test.mjs, plus post classification. */
class FetcherTest {
    private fun pk(n: Int) = n.toString(16).padStart(64, '0')
    private fun kind0(p: String, name: String) = NostrEvent("x", p, 100, 0, emptyList(), "{\"name\":\"$name\"}")
    private fun list(p: String, tags: List<List<String>>) = NostrEvent("x", p, 100, 10002, tags, "")
    private val main = listOf("wss://main.example")
    private val index = listOf("wss://index.example")
    private fun make(pool: RelayPoolApi) = Fetcher(pool, main, index)

    @Test
    fun `small-batch retry recovers what a big indexer filter dropped`() = runBlocking {
        val keys = (1..60).map(::pk)
        val pool = FakePool { relay, f ->
            if (relay != index[0] || f.kinds?.contains(0) != true) return@FakePool emptyList()
            val authors = if (f.authors!!.size > 25) f.authors.take(5) else f.authors
            authors.map { kind0(it, "n" + it.takeLast(2)) }
        }
        assertEquals(60, make(pool).getProfiles(keys).size)
        assertTrue(pool.calls.filter { it.relays[0] == index[0] }.all { it.filter.authors!!.size <= 25 })
    }

    @Test
    fun `a flaky first attempt is retried once`() = runBlocking {
        val a = pk(1)
        var n = 0
        val pool = FakePool { relay, f -> if (relay == index[0] && f.kinds!!.contains(0) && ++n >= 2) listOf(kind0(a, "Minibits")) else emptyList() }
        assertEquals("Minibits", make(pool).getProfiles(listOf(a))[a]?.name)
    }

    @Test
    fun `the outbox pass asks the authors' write relays, sanitised and capped`() = runBlocking {
        val a = pk(1)
        val b = pk(2)
        val pool = FakePool { relay, f ->
            when {
                f.kinds!!.contains(10002) -> listOf(
                    list(a, listOf(listOf("r", "wss://own.example"), listOf("r", "wss://read-only.example", "read"), listOf("r", "ws://plain.example"), listOf("r", "wss://127.0.0.1"), listOf("r", "wss://w2.example", "write"), listOf("r", "wss://w3.example"), listOf("r", "wss://w4.example"))),
                    list(b, listOf(listOf("r", "wss://own.example", "write"))),
                )
                relay == "wss://own.example" -> f.authors!!.map { kind0(it, "who" + it.last()) }
                else -> emptyList()
            }
        }
        val got = make(pool).getProfiles(listOf(a, b))
        assertEquals("who1", got[a]?.name)
        assertEquals("who2", got[b]?.name)
        val asked = pool.calls.filter { it.filter.kinds!!.contains(0) }.flatMap { it.relays }.toSet()
        assertFalse("wss://read-only.example" in asked)
        assertFalse("ws://plain.example" in asked)
        assertFalse(asked.any { it.contains("127.0.0.1") })
    }

    @Test
    fun `the outbox pass is capped at 12 relays`() = runBlocking {
        val keys = (1..20).map(::pk)
        val pool = FakePool { _, f ->
            if (f.kinds!!.contains(10002)) f.authors!!.map { list(it, listOf(listOf("r", "wss://r${it.toLong(16)}.example"))) } else emptyList()
        }
        make(pool).getProfiles(keys)
        val relays = pool.calls.filter { it.filter.kinds!!.contains(0) && it.relays[0].startsWith("wss://r") }.map { it.relays[0] }.toSet()
        assertEquals(12, relays.size)
    }

    @Test
    fun `never throws, keeps what resolved, ignores lists from the wrong author`() = runBlocking {
        val a = pk(1)
        val b = pk(2)
        val pool = FakePool { relay, _ -> if (relay == main[0]) listOf(kind0(a, "Alice")) else throw RuntimeException("relay down") }
        val got = make(pool).getProfiles(listOf(a, b))
        assertEquals("Alice", got[a]?.name)
        assertFalse(got.containsKey(b))

        val evil = FakePool { _, f -> if (f.kinds!!.contains(10002)) listOf(list(pk(9), listOf(listOf("r", "wss://evil.example")))) else emptyList() }
        make(evil).getProfiles(listOf(a))
        assertFalse(evil.calls.any { "wss://evil.example" in it.relays })
    }

    @Test
    fun `likes paging starts where no relay that hit the limit could have left a gap`() = runBlocking {
        val deep = "wss://deep.example"
        val dense = "wss://dense.example"
        val pool = FakePool { relay, f ->
            if (!f.kinds!!.contains(7)) return@FakePool emptyList()
            val start = if (relay == deep) 1000L else 1100L
            (0 until f.limit!!).map { NostrEvent("$relay${start + it}", pk(1), start + it, 7, emptyList(), "-") }
        }
        val likes = Fetcher(pool, listOf(deep, dense)).getLikes(pk(1), limit = 200)
        assertEquals(400, likes.reactionCount)
        assertTrue("${likes.nextUntil}", likes.nextUntil!! >= 1100)
    }

    @Test
    fun `likes resolve to the liked notes, dislikes and empty notes left out`() = runBlocking {
        val note = "n".repeat(0) + "1".repeat(64)
        val pool = FakePool { _, f ->
            when {
                f.kinds == listOf(7) -> listOf(
                    NostrEvent("r1", pk(1), 50, 7, listOf(listOf("e", note)), "+"),
                    NostrEvent("r2", pk(1), 40, 7, listOf(listOf("e", "2".repeat(64))), "-"),
                )
                f.ids != null -> listOf(NostrEvent(note, pk(3), 10, 1, emptyList(), "a liked note"))
                else -> emptyList()
            }
        }
        val likes = Fetcher(pool, main).getLikes(npub(pk(1)), limit = 200, until = 45)
        assertEquals(listOf("a liked note"), likes.likes.map { it.content })
        assertEquals("r1", likes.likes[0].reactionId)
        assertEquals(50L, likes.likes[0].reactedAt)
        assertEquals(40L, likes.nextUntil)
    }

    @Test
    fun `posts are classified, replies left out, embeds resolved`() = runBlocking {
        val now = 2_000_000_000L
        val origId = "0".repeat(63) + "a"
        val quotedId = "0".repeat(63) + "b"
        val embedded = """{"id":"${"c".repeat(64)}","pubkey":"${pk(5)}","content":"inline original","kind":1,"tags":[],"created_at":1,"sig":""}"""
        val events = listOf(
            NostrEvent("orig1", pk(1), now - 10, 1, emptyList(), "plain note"),
            NostrEvent("reply", pk(1), now - 20, 1, listOf(listOf("e", "root", "", "root")), "a reply"),
            NostrEvent("legacyReply", pk(1), now - 21, 1, listOf(listOf("e", "x")), "positional reply"),
            NostrEvent("mention", pk(1), now - 22, 1, listOf(listOf("e", quotedId, "", "mention")), "quoting with a mention tag"),
            NostrEvent("quote", pk(2), now - 30, 1, emptyList(), "look nostr:${nevent(quotedId)}"),
            NostrEvent("boost1", pk(3), now - 40, 6, listOf(listOf("e", origId)), ""),
            NostrEvent("boost2", pk(4), now - 50, 6, listOf(listOf("e", "c".repeat(64))), embedded),
            NostrEvent("old", pk(1), now - 100_000, 1, emptyList(), "too old"),
        )
        val pool = FakePool { _, f ->
            when {
                f.ids != null -> f.ids.mapNotNull { id ->
                    when (id) {
                        origId -> NostrEvent(origId, pk(6), 5, 1, emptyList(), "fetched original")
                        quotedId -> NostrEvent(quotedId, pk(7), 5, 1, emptyList(), "the quoted note")
                        else -> null
                    }
                }
                f.kinds == listOf(1, 6) -> events.filter { it.createdAt >= f.since!! }
                else -> emptyList()
            }
        }
        val posts = Fetcher(pool, main, clock = { now * 1000 }).getPosts((1..4).map(::pk), hoursBack = 24)
        assertEquals(listOf("orig1", "mention", "quote", "boost1", "boost2"), posts.map { it.id })
        assertEquals(PostType.Original, posts[0].type)
        assertEquals(PostType.Quote, posts[1].type)
        assertEquals("the quoted note", posts[1].quotedPost?.content)
        assertEquals(quotedId, posts[2].quotedPost?.id)
        assertEquals(PostType.Boost, posts[3].type)
        assertEquals("fetched original", posts[3].content)
        assertEquals(EmbeddedPost(origId, pk(6), "fetched original"), posts[3].originalPost)
        assertEquals("inline original", posts[4].content)
        assertEquals(pk(5), posts[4].originalPost?.author)
    }

    @Test
    fun `follows come from the newest kind 3`() = runBlocking {
        val pool = FakePool { relay, _ ->
            if (relay == main[0]) {
                listOf(
                    NostrEvent("old", pk(1), 1, 3, listOf(listOf("p", pk(8)))),
                    NostrEvent("new", pk(1), 2, 3, listOf(listOf("p", pk(9)), listOf("p", ""), listOf("t", "x"))),
                )
            } else emptyList()
        }
        assertEquals(listOf(pk(9)), Fetcher(pool, main).getFollows(pk(1)))
    }

    @Test
    fun `profiles keep the newest event, prefer display_name, skip bad JSON`() {
        val a = pk(1); val b = pk(2); val c = pk(3)
        val out = Fetcher.parseProfileEvents(
            listOf(
                NostrEvent("1", a, 1, 0, content = """{"name":"old"}"""),
                NostrEvent("2", a, 2, 0, content = """{"name":"nick","display_name":"Alice","lud16":"a@b.c"}"""),
                NostrEvent("3", b, 1, 0, content = "not json"),
                NostrEvent("4", c, 1, 0, content = """{"display_name":"  ","name":"carol"}"""),
            ),
        )
        assertEquals("Alice", out[a]?.name)
        assertEquals("a@b.c", out[a]?.lud16)
        assertFalse(out.containsKey(b))
        assertEquals("carol", out[c]?.name)
    }

    @Test
    fun `referenced pubkeys and who a feed needs profiles for`() {
        val a = "a".repeat(64); val b = "b".repeat(64); val c = "c".repeat(64); val d = "d".repeat(64)
        val text = "hi nostr:${npub(a)} and nostr:${nprofile(b, "wss://r.example")} nostr:npub1notvalid"
        assertEquals(listOf(a, b), Pubkeys.extractReferencedPubkeys(text).sorted())
        val posts = listOf(
            Pubkeys.PostLike(a, "", originalPost = EmbeddedPost("x", b, "cc nostr:${npub(d)}")),
            Pubkeys.PostLike(c, "quote", quotedPost = EmbeddedPost("y", a, "")),
        )
        assertEquals(listOf(a, b, c, d), Pubkeys.collectPostPubkeys(posts))
        assertEquals(listOf(a, b), Pubkeys.collectPostPubkeys(listOf(Pubkeys.PostLike(a, "nostr:${npub(d)}", originalPost = EmbeddedPost("x", b, ""))), 2))
    }

    @Test
    fun `pubkeyToHex takes npub, nprofile and hex, never anything else`() {
        val a = "A".repeat(64)
        assertEquals(a.lowercase(), pubkeyToHex(a))
        assertEquals(a.lowercase(), pubkeyToHex(npub(a.lowercase())))
        assertEquals(a.lowercase(), pubkeyToHex(nprofile(a.lowercase(), "wss://x")))
        assertNull(pubkeyToHexOrNull("nsec1private"))
        assertNull(pubkeyToHexOrNull(nevent(a.lowercase())))
        assertNull(pubkeyToHexOrNull(""))
    }

    @Test
    fun `reply and quote detection follow nip10`() {
        fun ev(tags: List<List<String>>, content: String = "x") = NostrEvent("i", pk(1), 1, 1, tags, content)
        assertTrue(Fetcher.isReply(ev(listOf(listOf("e", "x")))))
        assertTrue(Fetcher.isReply(ev(listOf(listOf("e", "x", "", "reply")))))
        assertFalse(Fetcher.isReply(ev(listOf(listOf("e", "x", "", "mention")))))
        assertFalse(Fetcher.isReply(ev(listOf(listOf("e", "")))))
        assertFalse(Fetcher.isReply(ev(listOf(listOf("q", "x")))))
        assertTrue(Fetcher.isQuotePost(ev(emptyList(), "see nostr:note1abc")))
        assertEquals("qq", Fetcher.getQuotedEventId(ev(listOf(listOf("e", "m", "", "mention"), listOf("q", "qq")))))
        assertNull(Fetcher.parseRepostContent(ev(emptyList(), "{\"id\":\"x\"}")))
    }
}
