package today.cypherpunk.nostrsignin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Nip55ParseTest {
    private val pubkey = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
    private val event = UnsignedEvent.loginProof(pubkey, "abc123", "example.com", 1700000000)
    private val sig = "e2b4f4f2c9c30072acee7db5406bb11ebd20410651ba5c0f16afe4136b4d369faa8490af22038b2e9fc174c9d9956cbf1bb47f6d8aad8ec4d6af2eeb4ac5fe93"
    private val signedByNak = """{"kind":22242,"id":"${event.id}","pubkey":"$pubkey","created_at":1700000000,"tags":[["challenge","abc123"],["domain","example.com"]],"content":"","sig":"$sig"}"""

    private fun extras(vararg pairs: Pair<String, String>): (String) -> String? = mapOf(*pairs)::get

    @Test fun publicKeyAsNpubOrHex() {
        val npub = Bech32.npub(pubkey)
        assertEquals(Nip55.Reply.PublicKey(pubkey, "com.signer"), Nip55.parsePublicKey(extras("result" to npub, "package" to "com.signer")))
        assertEquals(Nip55.Reply.PublicKey(pubkey, null), Nip55.parsePublicKey(extras("result" to pubkey)))
        assertEquals(Nip55.Reply.Empty, Nip55.parsePublicKey(extras("result" to "nonsense")))
    }

    @Test fun wholeEvent() {
        val reply = Nip55.parseSigned(event, extras("event" to signedByNak, "result" to sig))
        assertEquals(Nip55.Reply.Signed(event.signedJson(sig)), reply)
    }

    @Test fun signatureOnly() {
        assertEquals(Nip55.Reply.Signed(event.signedJson(sig)), Nip55.parseSigned(event, extras("result" to sig)))
        assertEquals(Nip55.Reply.Signed(event.signedJson(sig)), Nip55.parseSigned(event, extras("signature" to sig.uppercase())))
    }

    @Test fun batchedResults() {
        val results = """[{"package":"com.signer","result":"$sig","id":"${event.id}"}]"""
        assertEquals(Nip55.Reply.Signed(event.signedJson(sig)), Nip55.parseSigned(event, extras("results" to results)))
    }

    @Test fun refusesSomeoneElsesEvent() {
        val other = signedByNak.replace("1700000000", "1700000005")
        assertEquals(Nip55.Reply.Empty, Nip55.parseSigned(event, extras("event" to other)))
        assertEquals(Nip55.Reply.Empty, Nip55.parseSigned(event, extras("result" to "not-a-signature")))
    }

    @Test fun signedJsonIsCanonical() {
        val json = event.signedJson(sig)
        assertTrue(json.startsWith("{\"id\":\"${event.id}\",\"pubkey\":\"$pubkey\""))
        assertTrue(json.endsWith("\"sig\":\"$sig\"}"))
    }
}
