package today.cypherpunk.nalgorithm.nostr

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrsignin.UnsignedEvent

/** Expected strings come from nostr-tools 2.23.3, the library the web app uses. */
class Nip19AndEventTest {
    private val pk = "b".repeat(64)
    private val id = "1".repeat(64)

    @Test fun encodesLikeNostrTools() {
        assertEquals("npub1hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwasxw04hu", Nip19.npub(pk))
        assertEquals("note1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsglnzgl", Nip19.note(id))
        assertEquals(
            "nprofile1qyxhwumn8ghj7mn0wvhxcmmvqyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqqyzamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamksvrl6r",
            Nip19.nprofile(pk, listOf("wss://nos.lol", "wss://relay.primal.net")),
        )
        assertEquals(
            "nevent1qvzqqqqqqypzpwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamqyxhwumn8ghj7mn0wvhxcmmvqqspzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygn4pr3m",
            Nip19.nevent(id, listOf("wss://nos.lol"), pk, 1),
        )
        assertEquals("nevent1qqspzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyge5zfxv", Nip19.nevent(id))
        assertEquals(
            "naddr1qvzqqqr4gupzpwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamqyxhwumn8ghj7mn0wvhxcmmvqq9x67fdv9e8g6trd3jsdf7l9p",
            Nip19.naddr("my-article", pk, 30023, listOf("wss://nos.lol")),
        )
    }

    @Test fun decodesEveryType() {
        assertEquals(Nip19.Npub(pk), Nip19.decode(Nip19.npub(pk)))
        assertEquals(Nip19.Note(id), Nip19.decode("nostr:" + Nip19.note(id)))
        assertEquals(Nip19.Nprofile(pk, listOf("wss://nos.lol")), Nip19.decode(Nip19.nprofile(pk, listOf("wss://nos.lol"))))
        assertEquals(Nip19.Nevent(id, listOf("wss://nos.lol"), pk, 1), Nip19.decode(Nip19.nevent(id, listOf("wss://nos.lol"), pk, 1)))
        assertEquals(Nip19.Nevent(id, emptyList(), null, null), Nip19.decode(Nip19.nevent(id)))
        assertEquals(Nip19.Naddr("my-article", pk, 30023, listOf("wss://nos.lol")), Nip19.decode(Nip19.naddr("my-article", pk, 30023, listOf("wss://nos.lol"))))
    }

    @Test fun rejectsMalformed() {
        val npub = Nip19.npub(pk)
        assertNull(Nip19.decode(npub.dropLast(1) + if (npub.endsWith("q")) "p" else "q"))
        assertNull(Nip19.decode("nsec1hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwasxw04hu"))
        assertNull(Nip19.decode("hello"))
        assertEquals("", Nip19.npub("xyz"))
        assertEquals("", Nip19.nevent("nothex"))
    }

    @Test fun pubkeyOfAcceptsNpubNprofileAndHex() {
        assertEquals(pk, Nip19.pubkeyOf(Nip19.npub(pk)))
        assertEquals(pk, Nip19.pubkeyOf(Nip19.nprofile(pk)))
        assertEquals(pk, Nip19.pubkeyOf(pk.uppercase()))
        assertEquals(pk, Nip19.pubkeyOf("  nostr:${Nip19.npub(pk)} "))
        assertNull(Nip19.pubkeyOf(Nip19.note(id)))
        assertNull(Nip19.pubkeyOf("npub1nope"))
        assertEquals(id, Nip19.eventIdOf(Nip19.nevent(id)))
    }

    @Test fun nprofileKeepsOnlyRealRelayHints() {
        val decoded = Nip19.decode(Nip19.nprofile(pk, listOf("wss://a.example", "https://web.example", "wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example")))
        assertEquals(listOf("wss://a.example", "wss://b.example", "wss://c.example"), (decoded as Nip19.Nprofile).relays)
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    private val signedJson =
        """{"kind":1,"created_at":1700000000,"tags":[["e","1111111111111111111111111111111111111111111111111111111111111111","","root"],["p","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]],"content":"hello \"world\"\n\\ /tab\t\u0001 é 🍕","pubkey":"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9","id":"3e280d67690fd0b06f192dced909eb904111c7dc1092105ea7202b9458563d21","sig":"008b5a02d4df2a17847d799fb167cd39b4581ef0bcd819df6034ed191f3528ebe3b9d3d9542fc357e0c09b1bb316f6409c5159c134afa80e98dbf4a6fce6c474"}"""

    @Test fun parsesAndVerifiesAnEventSignedByNostrTools() {
        val event = parseEvent(Json.parseToJsonElement(signedJson))!!
        assertTrue(event.verify())
        assertEquals("3e280d67690fd0b06f192dced909eb904111c7dc1092105ea7202b9458563d21", event.unsigned().id)
        // Same bytes as JSON.stringify(event) on the web: boosts and zap requests depend on it.
        assertEquals(signedJson, event.toJsonString())
    }

    @Test fun rejectsTamperedEvents() {
        val event = parseEvent(Json.parseToJsonElement(signedJson))!!
        assertFalse(event.copy(content = "hello").verify())
        assertFalse(event.copy(sig = "1" + event.sig.drop(1)).verify())
        assertFalse(event.copy(createdAt = event.createdAt + 1).verify())
        assertNull(parseEvent(Json.parseToJsonElement(signedJson.replace("\"kind\":1", "\"kind\":\"1\""))))
        assertNull(parseEvent(Json.parseToJsonElement(signedJson.replace("\"tags\":[[", "\"tags\":[[1,"))))
    }

    @Test fun signsLocally() {
        val secret = ByteArray(32).also { it[31] = 3 }
        assertEquals("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9", Keys.publicHex(secret))
        val event = signLocal(UnsignedEvent(Keys.publicHex(secret), 1700000000, 1, listOf(listOf("t", "x")), "hi"), secret)
        assertTrue(event.verify())
        assertEquals(event.id, UnsignedEvent(event.pubkey, event.createdAt, event.kind, event.tags, event.content).id)
    }
}
