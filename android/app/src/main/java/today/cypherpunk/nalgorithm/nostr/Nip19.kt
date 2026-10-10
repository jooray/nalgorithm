package today.cypherpunk.nalgorithm.nostr

import today.cypherpunk.nostrsignin.Bech32
import java.io.ByteArrayOutputStream

/**
 * NIP-19 identifiers: npub, note, nprofile, nevent and naddr, with TLV. Encodes
 * byte for byte what nostr-tools encodes (TLV entries in descending type order),
 * so links match the web app's.
 *
 * Rule from the web (identity.ts): nothing user-facing shows a hex key, so the
 * encoders return "" rather than hex when a value cannot be encoded.
 */
object Nip19 {
    sealed interface Decoded
    data class Npub(val pubkey: String) : Decoded
    data class Note(val id: String) : Decoded
    data class Nprofile(val pubkey: String, val relays: List<String>) : Decoded
    data class Nevent(val id: String, val relays: List<String>, val author: String?, val kind: Int?) : Decoded
    data class Naddr(val identifier: String, val pubkey: String, val kind: Int, val relays: List<String>) : Decoded

    fun npub(pubkey: String): String = if (Hex.isHex64(pubkey.lowercase())) Bech32.encode("npub", Hex.decode(pubkey.lowercase())) else ""

    fun note(id: String): String = if (Hex.isHex64(id.lowercase())) Bech32.encode("note", Hex.decode(id.lowercase())) else ""

    /** nprofile with up to three relay hints (identity.ts: a hint we did not learn would be invented). */
    fun nprofile(pubkey: String, relays: List<String> = emptyList()): String {
        val pk = pubkey.lowercase()
        if (!Hex.isHex64(pk)) return ""
        val hints = relays.filter { RELAY_HINT.matches(it) }.distinct().take(3)
        return Bech32.encode("nprofile", tlv(listOf(1 to hints.map(::utf8), 0 to listOf(Hex.decode(pk)))))
    }

    fun nevent(id: String, relays: List<String> = emptyList(), author: String? = null, kind: Int? = null): String {
        val i = id.lowercase()
        if (!Hex.isHex64(i)) return ""
        val a = author?.lowercase()?.takeIf(Hex::isHex64)
        return Bech32.encode(
            "nevent",
            tlv(
                listOf(
                    3 to listOfNotNull(kind?.let(::u32)),
                    2 to listOfNotNull(a?.let(Hex::decode)),
                    1 to relays.map(::utf8),
                    0 to listOf(Hex.decode(i)),
                ),
            ),
        )
    }

    fun naddr(identifier: String, pubkey: String, kind: Int, relays: List<String> = emptyList()): String {
        val pk = pubkey.lowercase()
        if (!Hex.isHex64(pk)) return ""
        return Bech32.encode(
            "naddr",
            tlv(listOf(3 to listOf(u32(kind)), 2 to listOf(Hex.decode(pk)), 1 to relays.map(::utf8), 0 to listOf(utf8(identifier)))),
        )
    }

    /** Any of the five, with or without a `nostr:` prefix. Null when malformed. */
    fun decode(code: String): Decoded? {
        val text = code.trim().removePrefix("nostr:")
        val (hrp, data) = Bech32.decode(text) ?: return null
        return runCatching {
            when (hrp) {
                "npub" -> if (data.size == 32) Npub(Hex.encode(data)) else null
                "note" -> if (data.size == 32) Note(Hex.encode(data)) else null
                "nprofile" -> {
                    val t = parseTlv(data) ?: return null
                    val pk = t[0]?.firstOrNull()?.takeIf { it.size == 32 } ?: return null
                    Nprofile(Hex.encode(pk), t[1].orEmpty().map(::fromUtf8))
                }
                "nevent" -> {
                    val t = parseTlv(data) ?: return null
                    val id = t[0]?.firstOrNull()?.takeIf { it.size == 32 } ?: return null
                    val author = t[2]?.firstOrNull()
                    if (author != null && author.size != 32) return null
                    val kind = t[3]?.firstOrNull()
                    if (kind != null && kind.size != 4) return null
                    Nevent(Hex.encode(id), t[1].orEmpty().map(::fromUtf8), author?.let(Hex::encode), kind?.let(::readU32))
                }
                "naddr" -> {
                    val t = parseTlv(data) ?: return null
                    val identifier = t[0]?.firstOrNull() ?: return null
                    val pk = t[2]?.firstOrNull()?.takeIf { it.size == 32 } ?: return null
                    val kind = t[3]?.firstOrNull()?.takeIf { it.size == 4 } ?: return null
                    Naddr(fromUtf8(identifier), Hex.encode(pk), readU32(kind), t[1].orEmpty().map(::fromUtf8))
                }
                else -> null
            }
        }.getOrNull()
    }

    /** The hex pubkey behind an npub, nprofile or 64-char hex (any case), or null. */
    fun pubkeyOf(value: String): String? {
        val v = value.trim().removePrefix("nostr:")
        if (v.length == 64 && v.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return v.lowercase()
        return when (val d = decode(v)) {
            is Npub -> d.pubkey
            is Nprofile -> d.pubkey
            else -> null
        }
    }

    /** The event id behind a note or nevent (or a hex id), or null. */
    fun eventIdOf(value: String): String? {
        val v = value.trim().removePrefix("nostr:")
        if (Hex.isHex64(v.lowercase())) return v.lowercase()
        return when (val d = decode(v)) {
            is Note -> d.id
            is Nevent -> d.id
            else -> null
        }
    }

    /** NIP-21 URI. */
    fun uri(bech32: String): String = "nostr:$bech32"

    private val RELAY_HINT = Regex("^wss?://\\S+$", RegexOption.IGNORE_CASE)

    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)

    private fun fromUtf8(b: ByteArray): String {
        val decoder = Charsets.UTF_8.newDecoder()
        return decoder.decode(java.nio.ByteBuffer.wrap(b)).toString()
    }

    private fun u32(n: Int) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())

    private fun readU32(b: ByteArray): Int =
        ((b[0].toInt() and 0xff) shl 24) or ((b[1].toInt() and 0xff) shl 16) or ((b[2].toInt() and 0xff) shl 8) or (b[3].toInt() and 0xff)

    private fun tlv(entries: List<Pair<Int, List<ByteArray>>>): ByteArray {
        val out = ByteArrayOutputStream()
        for ((type, values) in entries) {
            for (v in values) {
                if (v.size > 255) continue
                out.write(type)
                out.write(v.size)
                out.write(v)
            }
        }
        return out.toByteArray()
    }

    private fun parseTlv(data: ByteArray): Map<Int, List<ByteArray>>? {
        val out = HashMap<Int, MutableList<ByteArray>>()
        var i = 0
        while (i < data.size) {
            if (i + 2 > data.size) return null
            val t = data[i].toInt() and 0xff
            val l = data[i + 1].toInt() and 0xff
            if (i + 2 + l > data.size) return null
            out.getOrPut(t) { ArrayList() }.add(data.copyOfRange(i + 2, i + 2 + l))
            i += 2 + l
        }
        return out
    }
}
