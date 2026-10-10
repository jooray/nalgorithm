package today.cypherpunk.nalgorithm.nostr

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The official NIP-44 v2 vectors (github.com/paulmillr/nip44, nip44.vectors.json). */
class Nip44Test {
    private val v2: JsonObject by lazy {
        val text = javaClass.getResourceAsStream("nip44.vectors.json")!!.bufferedReader().readText()
        Json.parseToJsonElement(text).jsonObject["v2"]!!.jsonObject
    }
    private fun valid(name: String): JsonArray = v2["valid"]!!.jsonObject[name]!!.jsonArray
    private fun invalid(name: String): JsonArray = v2["invalid"]!!.jsonObject[name]!!.jsonArray
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun conversationKeys() {
        val vectors = valid("get_conversation_key")
        assertTrue(vectors.size > 30)
        for (v in vectors.map { it.jsonObject }) {
            val key = Nip44.conversationKey(Hex.decode(v.s("sec1")), v.s("pub2"))
            assertEquals(v.s("conversation_key"), Hex.encode(key))
        }
    }

    @Test fun messageKeys() {
        val group = v2["valid"]!!.jsonObject["get_message_keys"]!!.jsonObject
        val conv = Hex.decode(group.s("conversation_key"))
        for (k in group["keys"]!!.jsonArray.map { it.jsonObject }) {
            val keys = Nip44.messageKeys(conv, Hex.decode(k.s("nonce")))
            assertEquals(k.s("chacha_key"), Hex.encode(keys.chachaKey))
            assertEquals(k.s("chacha_nonce"), Hex.encode(keys.chachaNonce))
            assertEquals(k.s("hmac_key"), Hex.encode(keys.hmacKey))
        }
    }

    @Test fun paddedLengths() {
        for (pair in valid("calc_padded_len")) {
            val (len, padded) = pair.jsonArray.map { it.jsonPrimitive.int }
            assertEquals("len $len", padded, Nip44.calcPaddedLen(len))
        }
    }

    @Test fun encryptAndDecrypt() {
        for (v in valid("encrypt_decrypt").map { it.jsonObject }) {
            val sec1 = Hex.decode(v.s("sec1"))
            val pub2 = Keys.publicHex(Hex.decode(v.s("sec2")))
            val conv = Nip44.conversationKey(sec1, pub2)
            assertEquals(v.s("conversation_key"), Hex.encode(conv))
            // Both directions derive the same key.
            assertArrayEquals(conv, Nip44.conversationKey(Hex.decode(v.s("sec2")), Keys.publicHex(sec1)))
            val payload = Nip44.encrypt(v.s("plaintext"), conv, Hex.decode(v.s("nonce")))
            assertEquals(v.s("payload"), payload)
            assertEquals(v.s("plaintext"), Nip44.decrypt(payload, conv))
        }
    }

    @Test fun longMessages() {
        for (v in valid("encrypt_decrypt_long_msg").map { it.jsonObject }) {
            val plaintext = v.s("pattern").repeat(v["repeat"]!!.jsonPrimitive.int)
            assertEquals(v.s("plaintext_sha256"), sha256Hex(plaintext))
            val conv = Hex.decode(v.s("conversation_key"))
            val payload = Nip44.encrypt(plaintext, conv, Hex.decode(v.s("nonce")))
            assertEquals(v.s("payload_sha256"), sha256Hex(payload))
            assertEquals(plaintext, Nip44.decrypt(payload, conv))
        }
    }

    @Test fun invalidConversationKeys() {
        for (v in invalid("get_conversation_key").map { it.jsonObject }) {
            try {
                Nip44.conversationKey(Hex.decode(v.s("sec1")), v.s("pub2"))
                fail("accepted: ${v.s("note")}")
            } catch (e: Nip44.Nip44Exception) {
                // expected
            }
        }
    }

    @Test fun invalidPayloads() {
        val vectors = invalid("decrypt").map { it.jsonObject }
        assertTrue(vectors.size >= 10)
        for (v in vectors) {
            try {
                Nip44.decrypt(v.s("payload"), Hex.decode(v.s("conversation_key")))
                fail("accepted: ${v.s("note")}")
            } catch (e: Nip44.Nip44Exception) {
                // expected
            }
        }
    }

    @Test fun invalidMessageLengths() {
        val conv = ByteArray(32) { 1 }
        for (len in invalid("encrypt_msg_lengths").map { it.jsonPrimitive.int }) {
            try {
                Nip44.encrypt("a".repeat(len), conv)
                fail("accepted length $len")
            } catch (e: Nip44.Nip44Exception) {
                // expected
            }
        }
    }

    @Test fun randomNonceRoundTrip() {
        val a = Keys.generateSecret()
        val b = Keys.generateSecret()
        val conv = Nip44.conversationKey(a, Keys.publicHex(b))
        val text = "{\"id\":\"x\",\"method\":\"get_public_key\",\"params\":[]} – ünïcödé 🍕"
        val one = Nip44.encrypt(text, conv)
        val two = Nip44.encrypt(text, conv)
        assertTrue(one != two)
        assertEquals(text, Nip44.decrypt(one, Nip44.conversationKey(b, Keys.publicHex(a))))
    }
}
