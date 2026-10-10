package today.cypherpunk.nalgorithm.engine

import today.cypherpunk.nostrsignin.Bech32

/** The NIP-19 decoding the library needs: npub, nprofile, note and nevent. */
object Nip19 {
    sealed interface Decoded {
        data class Npub(val pubkey: String) : Decoded
        data class Nprofile(val pubkey: String, val relays: List<String>) : Decoded
        data class Note(val id: String) : Decoded
        data class Nevent(val id: String, val relays: List<String>, val author: String?) : Decoded
        data class Other(val type: String) : Decoded
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /** Type-length-value entries, or null when the payload is malformed. */
    private fun tlv(data: ByteArray): Map<Int, List<ByteArray>>? {
        val out = LinkedHashMap<Int, MutableList<ByteArray>>()
        var i = 0
        while (i < data.size) {
            if (i + 2 > data.size) return null
            val t = data[i].toInt() and 0xff
            val l = data[i + 1].toInt() and 0xff
            if (i + 2 + l > data.size) return null
            out.getOrPut(t) { mutableListOf() }.add(data.copyOfRange(i + 2, i + 2 + l))
            i += 2 + l
        }
        return out
    }

    /** Decode, throwing like nip19.decode on anything invalid. */
    fun decode(text: String): Decoded {
        val (hrp, data) = Bech32.decode(text) ?: throw IllegalArgumentException("Invalid bech32: $text")
        return when (hrp) {
            "npub" -> {
                require(data.size == 32) { "Invalid npub" }
                Decoded.Npub(hex(data))
            }
            "note" -> {
                require(data.size == 32) { "Invalid note" }
                Decoded.Note(hex(data))
            }
            "nprofile" -> {
                val t = tlv(data) ?: throw IllegalArgumentException("Invalid nprofile")
                val key = t[0]?.firstOrNull()?.takeIf { it.size == 32 } ?: throw IllegalArgumentException("missing TLV 0 for nprofile")
                Decoded.Nprofile(hex(key), t[1].orEmpty().map { String(it, Charsets.US_ASCII) })
            }
            "nevent" -> {
                val t = tlv(data) ?: throw IllegalArgumentException("Invalid nevent")
                val id = t[0]?.firstOrNull()?.takeIf { it.size == 32 } ?: throw IllegalArgumentException("missing TLV 0 for nevent")
                Decoded.Nevent(hex(id), t[1].orEmpty().map { String(it, Charsets.US_ASCII) }, t[2]?.firstOrNull()?.takeIf { it.size == 32 }?.let(::hex))
            }
            else -> Decoded.Other(hrp)
        }
    }

    fun npubEncode(pubkeyHex: String): String = Bech32.npub(pubkeyHex)
}

private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")

/** Decode an npub, nprofile or hex pubkey to lowercase hex (lib pubkeyToHex). Throws on anything else. */
fun pubkeyToHex(input: String): String {
    if (HEX_64.matches(input)) return input.lowercase()
    try {
        return when (val d = Nip19.decode(input)) {
            is Nip19.Decoded.Npub -> d.pubkey
            is Nip19.Decoded.Nprofile -> d.pubkey
            else -> throw IllegalArgumentException("Unexpected nip19 type")
        }
    } catch (_: Exception) {
        throw IllegalArgumentException("Invalid pubkey or npub: $input")
    }
}

fun pubkeyToHexOrNull(input: String): String? = try { pubkeyToHex(input) } catch (_: Exception) { null }
