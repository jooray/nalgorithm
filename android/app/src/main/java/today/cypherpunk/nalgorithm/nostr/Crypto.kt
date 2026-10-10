package today.cypherpunk.nalgorithm.nostr

import fr.acinq.secp256k1.Secp256k1
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.security.MessageDigest
import java.security.SecureRandom

/** Lower-case hex helpers. */
object Hex {
    private const val DIGITS = "0123456789abcdef"

    fun encode(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            out[i * 2] = DIGITS[v ushr 4]
            out[i * 2 + 1] = DIGITS[v and 0x0f]
        }
        return String(out)
    }

    /** Bytes of an even-length hex string; throws on anything else. */
    fun decode(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd hex length" }
        return ByteArray(hex.length / 2) { i ->
            val hi = Character.digit(hex[i * 2], 16)
            val lo = Character.digit(hex[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "not hex" }
            ((hi shl 4) or lo).toByte()
        }
    }

    fun isHex(value: String?, length: Int): Boolean =
        value != null && value.length == length && value.all { it in '0'..'9' || it in 'a'..'f' }

    /** Lower-case 64-char hex (an id or pubkey). */
    fun isHex64(value: String?): Boolean = isHex(value, 64)
}

internal val secureRandom = SecureRandom()

fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

fun sha256Hex(text: String): String = Hex.encode(sha256(text.toByteArray(Charsets.UTF_8)))

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { secureRandom.nextBytes(it) }

/** BIP-340 keys and signatures through libsecp256k1. */
object Keys {
    /** A fresh valid secret key. */
    fun generateSecret(): ByteArray {
        while (true) {
            val k = randomBytes(32)
            if (Secp256k1.secKeyVerify(k)) return k
        }
    }

    /** The x-only public key (32 bytes) of [secret]. */
    fun xOnlyPublic(secret: ByteArray): ByteArray = Secp256k1.pubkeyCreate(secret).copyOfRange(1, 33)

    fun publicHex(secret: ByteArray): String = Hex.encode(xOnlyPublic(secret))

    fun signSchnorr(message32: ByteArray, secret: ByteArray): ByteArray =
        Secp256k1.signSchnorr(message32, secret, randomBytes(32))

    fun verifySchnorr(signature: ByteArray, message32: ByteArray, xOnlyPub: ByteArray): Boolean =
        runCatching { Secp256k1.verifySchnorr(signature, message32, xOnlyPub) }.getOrDefault(false)

    /**
     * The x coordinate of [secret]·P, where P is the even-y point of the x-only
     * [pubHex] (NIP-44's ECDH input; unhashed, unlike libsecp256k1's ecdh()).
     */
    fun sharedX(secret: ByteArray, pubHex: String): ByteArray {
        val point = Secp256k1.pubKeyTweakMul(byteArrayOf(0x02) + Hex.decode(pubHex), secret)
        return point.copyOfRange(1, 33)
    }
}

// ─── Events ──────────────────────────────────────────────────────────────────

fun NostrEvent.unsigned(): UnsignedEvent = UnsignedEvent(pubkey, createdAt, kind, tags, content)

/** NIP-01 wire JSON with the id recomputed from the fields (never the id a relay claimed). */
fun NostrEvent.toWireJson(): String = unsigned().signedJson(sig)

/**
 * The event as JSON with its own fields, in nostr-tools' key order (what
 * `JSON.stringify(event)` gives on the web): the content of a boost and the
 * zap request sent to an LNURL server.
 */
fun NostrEvent.toJsonString(): String = buildString {
    append("{\"kind\":").append(kind)
    append(",\"created_at\":").append(createdAt)
    append(",\"tags\":").append(tags.joinToString(",", "[", "]") { t -> t.joinToString(",", "[", "]") { jsonQuote(it) } })
    append(",\"content\":").append(jsonQuote(content))
    append(",\"pubkey\":").append(jsonQuote(pubkey))
    append(",\"id\":").append(jsonQuote(id))
    append(",\"sig\":").append(jsonQuote(sig))
    append('}')
}

/** JSON string escaping as JSON.stringify does it (and NIP-01 requires): `"`, `\\` and control characters only. */
fun jsonQuote(value: String): String = buildString(value.length + 2) {
    append('"')
    for (c in value) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
    append('"')
}

/** True when the id is the hash of the fields and the signature is valid for the pubkey. */
fun NostrEvent.verify(): Boolean {
    if (!Hex.isHex64(id) || !Hex.isHex64(pubkey) || !Hex.isHex(sig, 128)) return false
    if (unsigned().id != id) return false
    return Keys.verifySchnorr(Hex.decode(sig), Hex.decode(id), Hex.decode(pubkey))
}

/** Sign [event] with a local key (NIP-46 client envelopes, tests). The pubkey must be the key's. */
fun signLocal(event: UnsignedEvent, secret: ByteArray): NostrEvent {
    require(event.pubkey == Keys.publicHex(secret)) { "pubkey does not match the key" }
    val sig = Hex.encode(Keys.signSchnorr(Hex.decode(event.id), secret))
    return NostrEvent(event.id, event.pubkey, event.createdAt, event.kind, event.tags, event.content, sig)
}

/**
 * A strict read of an event object from the wire: every field present with the
 * right type and shape. Null for anything else (the caller verifies the signature).
 */
fun parseEvent(element: JsonElement?): NostrEvent? {
    val o = element as? JsonObject ?: return null
    fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    val id = str("id")?.takeIf(Hex::isHex64) ?: return null
    val pubkey = str("pubkey")?.takeIf(Hex::isHex64) ?: return null
    val sig = str("sig")?.takeIf { Hex.isHex(it, 128) } ?: return null
    val createdAt = (o["created_at"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return null
    val kind = (o["kind"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it in 0..65535 }?.toInt() ?: return null
    val content = str("content") ?: return null
    val tagsArray = o["tags"] as? JsonArray ?: return null
    val tags = ArrayList<List<String>>(tagsArray.size)
    for (t in tagsArray) {
        val arr = t as? JsonArray ?: return null
        tags.add(arr.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null })
    }
    if (createdAt < 0) return null
    return NostrEvent(id, pubkey, createdAt, kind, tags, content, sig)
}

fun nowSeconds(): Long = System.currentTimeMillis() / 1000
