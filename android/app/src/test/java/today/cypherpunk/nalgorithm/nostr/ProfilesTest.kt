package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.util.concurrent.CopyOnWriteArrayList

/** Ports of lib/test/profiles.test.mjs and web/test/lazy-profiles.test.mjs, plus the parser. */
class ProfilesTest {
    private fun pk(n: Int) = n.toString(16).padStart(64, '0')
    private fun kind0(p: String, content: String, at: Long = 100) = NostrEvent("x", p, at, 0, emptyList(), content, "y")
    private fun named(p: String, name: String) = kind0(p, "{\"name\":\"$name\"}")
    private fun list(p: String, tags: List<List<String>>) = NostrEvent("x", p, 100, 10002, tags, "", "y")

    /** A fake pool: serve(relay, filter) returns events; every call is logged. */
    private class FakePool(val serve: (String, Filter, Int) -> List<NostrEvent>) : RelayPoolApi {
        data class Call(val relays: List<String>, val filter: Filter)
        val calls = CopyOnWriteArrayList<Call>()
        override suspend fun query(relays: List<String>, filters: List<Filter>, timeoutMs: Long): List<NostrEvent> {
            calls.add(Call(relays, filters[0]))
            return relays.flatMap { serve(it, filters[0], calls.size) }
        }
        override suspend fun get(relays: List<String>, filter: Filter, timeoutMs: Long): NostrEvent? = null
        override suspend fun publish(relays: List<String>, event: NostrEvent, timeoutMs: Long): Map<String, Boolean> = emptyMap()
        override fun subscribe(relays: List<String>, filters: List<Filter>): Flow<NostrEvent> = emptyFlow()
    }

    private val main = listOf("wss://main.example")
    private val index = listOf("wss://index.example")

    @Test fun parseKeepsTheNewestAndPrefersDisplayName() {
        val a = pk(1)
        val out = Profiles.parseProfileEvents(
            listOf(
                kind0(a, "{\"name\":\"old\"}", 50),
                kind0(a, "{\"name\":\"n\",\"display_name\":\"  Display  \",\"picture\":\"https://p.example/a.png\",\"nip05\":\"a@b.example\",\"lud16\":\"a@b.example\"}", 60),
                kind0(pk(2), "not json"),
                kind0(pk(3), "{\"name\":\"\",\"picture\":\"javascript:alert(1)\"}"),
                kind0(pk(4), "{\"name\":\"${"x".repeat(1000)}\"}"),
            ),
        )
        assertEquals(ProfileData(a, "Display", "https://p.example/a.png", "a@b.example", "a@b.example", null), out[a])
        assertFalse(out.containsKey(pk(2)))
        assertEquals(ProfileData(pk(3)), out[pk(3)])
        assertEquals(256, out[pk(4)]!!.name!!.length)
    }

    @Test fun smallBatchRetryRecoversWhatABigIndexerFilterDropped() = runBlocking {
        val keys = (1..60).map(::pk)
        val pool = FakePool { relay, f, _ ->
            if (relay != index[0] || f.kinds != listOf(0)) emptyList()
            else (if (f.authors!!.size > 25) f.authors!!.take(5) else f.authors!!).map { named(it, "n" + it.takeLast(2)) }
        }
        val got = Profiles.fetch(pool, keys, main, index)
        assertEquals(60, got.size)
        assertTrue(pool.calls.filter { it.relays[0] == index[0] }.all { it.filter.authors!!.size <= 25 })
    }

    @Test fun aFlakyFirstAttemptIsRetriedOnce() = runBlocking {
        val a = pk(1)
        var n = 0
        val pool = FakePool { relay, f, _ -> if (relay == index[0] && f.kinds == listOf(0) && ++n >= 2) listOf(named(a, "Minibits")) else emptyList() }
        assertEquals("Minibits", Profiles.fetch(pool, listOf(a), main, index)[a]?.name)
    }

    @Test fun outboxPassAsksAuthorWriteRelaysSanitisedAndCapped() = runBlocking {
        val a = pk(1)
        val b = pk(2)
        val pool = FakePool { relay, f, _ ->
            when {
                f.kinds == listOf(10002) -> listOf(
                    list(a, listOf(listOf("r", "wss://own.example"), listOf("r", "wss://read-only.example", "read"), listOf("r", "ws://plain.example"), listOf("r", "wss://127.0.0.1"), listOf("r", "wss://w2.example", "write"), listOf("r", "wss://w3.example"), listOf("r", "wss://w4.example"))),
                    list(b, listOf(listOf("r", "wss://own.example", "write"))),
                )
                relay == "wss://own.example" -> f.authors!!.map { named(it, "who" + it.last()) }
                else -> emptyList()
            }
        }
        val got = Profiles.fetch(pool, listOf(a, b), main, index)
        assertEquals("who1", got[a]?.name)
        assertEquals("who2", got[b]?.name)
        val asked = pool.calls.filter { it.filter.kinds == listOf(0) }.flatMap { it.relays }.toSet()
        assertFalse("wss://read-only.example" in asked)
        assertFalse("ws://plain.example" in asked)
        assertFalse(asked.any { it.contains("127.0.0.1") })
        assertTrue(asked.count { it in setOf("wss://own.example", "wss://w2.example", "wss://w3.example", "wss://w4.example") } <= 4)
    }

    @Test fun outboxPassIsCappedAt12Relays() = runBlocking {
        val keys = (1..20).map(::pk)
        val pool = FakePool { _, f, _ ->
            if (f.kinds == listOf(10002)) f.authors!!.map { a -> list(a, listOf(listOf("r", "wss://r${a.toLong(16)}.example"))) } else emptyList()
        }
        Profiles.fetch(pool, keys, main, index)
        val outbox = pool.calls.filter { it.filter.kinds == listOf(0) && it.relays[0].startsWith("wss://r") }.map { it.relays[0] }.toSet()
        assertEquals(12, outbox.size)
    }

    @Test fun neverThrowsAndKeepsWhatResolved() = runBlocking {
        val a = pk(1)
        val pool = FakePool { relay, _, _ -> if (relay == main[0]) listOf(named(a, "Alice")) else throw IllegalStateException("relay down") }
        val got = Profiles.fetch(pool, listOf(a, pk(2)), main, index)
        assertEquals("Alice", got[a]?.name)
        assertFalse(got.containsKey(pk(2)))
    }

    @Test fun skipsOutboxEventsFromTheWrongAuthor() = runBlocking {
        val pool = FakePool { _, f, _ -> if (f.kinds == listOf(10002)) listOf(list(pk(9), listOf(listOf("r", "wss://evil.example")))) else emptyList() }
        Profiles.fetch(pool, listOf(pk(1)), main, index)
        assertFalse(pool.calls.any { "wss://evil.example" in it.relays })
    }

    @Test fun sanitizeRelayUrl() {
        assertEquals("wss://relay.damus.io", Profiles.sanitizeRelayUrl("wss://relay.damus.io/"))
        assertNull(Profiles.sanitizeRelayUrl("wss://10.0.0.1"))
        assertNull(Profiles.sanitizeRelayUrl("wss://[::1]"))
        assertNull(Profiles.sanitizeRelayUrl("ws://relay.damus.io"))
        assertNull(Profiles.sanitizeRelayUrl("wss://printer.local"))
        assertEquals("wss://relay.example/inbox", Profiles.sanitizeRelayUrl("wss://relay.example/inbox"))
    }

    // ─── ProfileCache ────────────────────────────────────────────────────────

    @Test fun cacheBatchesLookupsAndTriesEachPersonOnce() = runBlocking {
        val pool = FakePool { relay, f, _ -> if (relay == main[0] && f.kinds == listOf(0)) f.authors!!.map { named(it, "n" + it.last()) } else emptyList() }
        val cache = ProfileCache(pool, null, fallbackRelays = index, batchWindowMs = 50)
        val results = listOf(listOf(pk(1), pk(2)), listOf(pk(2), pk(3))).map { async { cache.load(it, main) } }.awaitAll()
        assertEquals(setOf(pk(1), pk(2)), results[0].keys)
        assertEquals(setOf(pk(2), pk(3)), results[1].keys)
        // One kind 0 query to the main relay for all three.
        val mainCalls = pool.calls.filter { it.relays == main && it.filter.kinds == listOf(0) }
        assertEquals(1, mainCalls.size)
        assertEquals(setOf(pk(1), pk(2), pk(3)), mainCalls[0].filter.authors!!.toSet())
        // Known ones come straight from memory; a miss is not asked again in this run.
        cache.load(listOf(pk(1), pk(9)), main)
        cache.load(listOf(pk(9)), main)
        assertEquals(2, pool.calls.count { it.relays == main && it.filter.kinds == listOf(0) })
        assertEquals("n1", cache.profiles.value[pk(1)]?.name)
    }

    @Test fun aLookupRightAfterConstructionCompletes() = runBlocking {
        // The batcher starts in init on another thread; it once ran before its channel
        // existed, died, and every load() then waited forever (no names in the feed).
        repeat(30) { i ->
            val pool = FakePool { _, f, _ -> if (f.kinds == listOf(0)) f.authors!!.map { named(it, "n$i") } else emptyList() }
            val cache = ProfileCache(pool, null, fallbackRelays = index, batchWindowMs = 1)
            val got = kotlinx.coroutines.withTimeout(5_000) { cache.load(listOf(pk(1)), main) }
            assertEquals("n$i", got[pk(1)]?.name)
        }
    }

    @Test fun rememberedProfilesWinOverSnapshots() {
        val cache = ProfileCache(FakePool { _, _, _ -> emptyList() }, null)
        cache.remember(mapOf(pk(1) to ProfileData(pk(1), "Fresh")))
        cache.rememberSnapshots(mapOf(pk(1) to today.cypherpunk.nalgorithm.model.ProfileSnapshot("Old"), pk(2) to today.cypherpunk.nalgorithm.model.ProfileSnapshot("Snap")))
        assertEquals("Fresh", cache.profiles.value[pk(1)]?.name)
        assertEquals("Snap", cache.profiles.value[pk(2)]?.name)
    }

    // ─── People on a card ────────────────────────────────────────────────────

    private fun hex(c: Char) = c.toString().repeat(64)
    private fun post(author: String, content: String = "", original: EmbeddedPost? = null, quoted: EmbeddedPost? = null) =
        ScoredPost(id = "1".repeat(64), type = PostType.Original, author = author, content = content, createdAt = 0, originalPost = original, quotedPost = quoted)

    @Test fun peopleOfAuthorBoostersOriginalAndQuoted() {
        val p = post(hex('a'), original = EmbeddedPost("x", hex('c'), ""), quoted = EmbeddedPost("y", hex('b'), ""))
        assertEquals(listOf(hex('a'), hex('b'), hex('c')), People.peopleOf(p, listOf(hex('b'), hex('a'), "nope")))
    }

    @Test fun peopleMentionedInTheTextCountToo() {
        val p = post(hex('a'), "thanks nostr:${Nip19.npub(hex('d'))}", original = EmbeddedPost("x", hex('b'), "cc nostr:${Nip19.nprofile(hex('e'))}"))
        assertEquals(listOf(hex('a'), hex('b'), hex('d'), hex('e')), People.peopleOf(p))
        assertEquals(listOf(hex('b'), hex('d'), hex('e')), People.unresolvedPeople(listOf(p), mapOf(hex('a') to ProfileData(hex('a')))))
        assertEquals(listOf(hex('a'), hex('b'), hex('d'), hex('e')), People.unresolvedPeople(listOf(p), null))
    }
}
