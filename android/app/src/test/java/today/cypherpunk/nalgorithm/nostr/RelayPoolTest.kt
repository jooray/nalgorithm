package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.nostr.TestEvents.alice
import today.cypherpunk.nalgorithm.nostr.TestEvents.bob
import today.cypherpunk.nalgorithm.nostr.TestEvents.json
import today.cypherpunk.nalgorithm.nostr.TestEvents.note

class RelayPoolTest {
    private val relays = FakeRelays()
    private val pool = RelayPool(relays, idleMs = 200)
    private val a = "wss://a.example"
    private val b = "wss://b.example"
    private val alicePk = Keys.publicHex(alice)

    @Test fun queryMergesAndDeduplicatesAcrossRelays() = runBlocking {
        val one = note(alice, "one")
        val two = note(alice, "two", 1_700_000_100)
        relays.relay(a).store(json(one), json(two))
        relays.relay(b).store(json(two))
        val got = pool.query(listOf(a, b), listOf(Filter(authors = listOf(alicePk))), 2_000)
        assertEquals(setOf(one.id, two.id), got.map { it.id }.toSet())
        assertEquals(2, got.size)
    }

    @Test fun dropsBadSignaturesAndEventsOutsideTheFilter() = runBlocking {
        val good = note(alice, "good")
        val forged = good.copy(content = "forged")
        val other = note(bob, "not asked for")
        relays.relay(a).store(json(good), forged.toJsonString(), json(other))
        val got = pool.query(listOf(a), listOf(Filter(authors = listOf(alicePk))), 2_000)
        assertEquals(listOf(good.id), got.map { it.id })
    }

    @Test fun aSilentOrBrokenRelayCostsOnlyItsTimeout() = runBlocking {
        val one = note(alice, "one")
        relays.relay(a).store(json(one))
        relays.relay(b).silent = true
        relays.relay("wss://broken.example").broken = true
        val started = System.currentTimeMillis()
        val got = pool.query(listOf(a, b, "wss://broken.example", "https://not-a-relay.example"), listOf(Filter(kinds = listOf(1))), 600)
        val took = System.currentTimeMillis() - started
        assertEquals(listOf(one.id), got.map { it.id })
        assertTrue("took $took", took in 550..3000)
    }

    @Test fun queryEndsAtEoseWithoutWaitingForTheTimeout() = runBlocking {
        relays.relay(a).store(json(note(alice, "x")))
        val started = System.currentTimeMillis()
        pool.query(listOf(a), listOf(Filter(kinds = listOf(1))), 5_000)
        assertTrue(System.currentTimeMillis() - started < 2_000)
        // CLOSE went out after EOSE.
        assertTrue(relays.relay(a).received.any { it.startsWith("[\"CLOSE\"") })
    }

    @Test fun getReturnsTheNewest() = runBlocking {
        val old = note(alice, "old", 100)
        val new = note(alice, "new", 200)
        relays.relay(a).store(json(old))
        relays.relay(b).store(json(new))
        assertEquals(new.id, pool.get(listOf(a, b), Filter(authors = listOf(alicePk)), 2_000)?.id)
        assertNull(pool.get(listOf(a), Filter(authors = listOf("f".repeat(64))), 1_000))
    }

    @Test fun connectionsAreSharedAndClosedWhenIdle() = runBlocking {
        relays.relay(a).store(json(note(alice, "x")))
        pool.query(listOf(a), listOf(Filter(kinds = listOf(1))), 2_000)
        pool.query(listOf(a), listOf(Filter(kinds = listOf(1))), 2_000)
        assertEquals(1, relays.opened.count { it == a })
        Thread.sleep(500)
        assertTrue(relays.relay(a).conns.isEmpty())
        pool.query(listOf(a), listOf(Filter(kinds = listOf(1))), 2_000)
        assertEquals(2, relays.opened.count { it == a })
    }

    @Test fun publishReportsEachRelay() = runBlocking {
        relays.relay(b).refuse = "blocked: no thanks"
        relays.relay("wss://silent.example").silent = true
        relays.relay("wss://broken.example").broken = true
        val event = note(alice, "hello")
        val seen = mutableListOf<RelayResult>()
        val results = pool.publishDetailed(listOf(a, b, "wss://silent.example", "wss://broken.example"), event, 600) { r, _ -> synchronized(seen) { seen.add(r) } }
        val byRelay = results.associateBy { it.relay }
        assertTrue(byRelay[a]!!.ok)
        assertEquals("blocked: no thanks", byRelay[b]!!.error)
        assertEquals("timed out", byRelay["wss://silent.example"]!!.error)
        assertEquals("TLS handshake failed", byRelay["wss://broken.example"]!!.error)
        assertEquals(4, seen.size)
        assertEquals(mapOf(a to true, b to false), pool.publish(listOf(a, b), event, 2_000))
    }

    @Test fun subscribeDeliversLiveEventsOnceAndSurvivesADrop() = runBlocking {
        val first = note(alice, "first", 1)
        val second = note(alice, "second", 2)
        relays.relay(a).store(json(first))
        relays.relay(b).store(json(first))
        val got = withTimeout(10_000) {
            pool.subscribe(listOf(a, b), listOf(Filter(authors = listOf(alicePk)))).take(2).also {
                Thread {
                    Thread.sleep(300)
                    relays.relay(a).dropAll()
                    Thread.sleep(1_500)
                    // Only reachable after the subscription came back on a.
                    relays.relay(b).silent = true
                    relays.relay(a).broadcast(json(second))
                }.start()
            }.toList()
        }
        assertEquals(listOf(first.id, second.id), got.map { it.id })
    }

    @Test fun cancellingTheFlowSendsClose() = runBlocking {
        val first = note(alice, "first")
        relays.relay(a).store(json(first))
        val got = pool.subscribe(listOf(a), listOf(Filter(kinds = listOf(1)))).first()
        assertEquals(first.id, got.id)
        Thread.sleep(100)
        assertTrue(relays.relay(a).received.any { it.startsWith("[\"CLOSE\"") })
    }
}
