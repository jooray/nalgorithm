package today.cypherpunk.nostrsignin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Vectors produced with `nak event --sec 0…03`.
class NostrEventTest {
    private val pubkey = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"

    @Test fun loginProofId() {
        val event = UnsignedEvent.loginProof(pubkey, "abc123", "example.com", 1700000000)
        assertEquals("ea5222eae22245afb4f0feb19d71f4b4870b93cb779bafd3958bc9af2755f389", event.id)
    }

    @Test fun escapingMatchesNip01() {
        val event = UnsignedEvent(pubkey, 1700000001, 1, emptyList(), "quote \" backslash \\ nl\ntab\tctl\u0001 é ⚡")
        assertEquals("a60bbc27f551ebeff2d07af61ab2d86764e000228db497865c7071c185c09d54", event.id)
    }

    @Test fun npubRoundTrip() {
        val npub = "npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266"
        assertEquals(npub, Bech32.npub(pubkey))
        assertEquals(pubkey, Bech32.pubkeyHex(npub))
        assertEquals(pubkey, Bech32.pubkeyHex(pubkey.uppercase()))
        assertNull(Bech32.pubkeyHex("npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq267"))
        assertNull(Bech32.pubkeyHex("nsec1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266"))
    }
}
