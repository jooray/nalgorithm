package today.cypherpunk.nalgorithm.ui.notes

import today.cypherpunk.nostrsignin.Bech32
import java.io.ByteArrayOutputStream

/**
 * The NIP-19 identifiers a note card needs (npub, nprofile, nevent, and reading
 * npub/nprofile mentions back), on top of the shared [Bech32]. Kept here so the
 * card does not depend on how the relay code encodes things.
 */
internal object NoteIds {
    private val HEX_64 = Regex("^[0-9a-f]{64}$")
    private val RELAY_HINT = Regex("^wss?://\\S+$", RegexOption.IGNORE_CASE)

    fun isHex64(value: String?): Boolean = value != null && HEX_64.matches(value)

    private fun hexBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hexOf(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** npub for a hex pubkey, or "" when it is not a valid key. Never returns hex. */
    fun npub(pubkey: String): String = if (isHex64(pubkey)) Bech32.encode("npub", hexBytes(pubkey)) else ""

    private fun tlv(out: ByteArrayOutputStream, type: Int, value: ByteArray) {
        if (value.size > 255) return
        out.write(type)
        out.write(value.size)
        out.write(value)
    }

    /**
     * nprofile with up to three relay hints. Only relays passed in are used:
     * a hint we did not learn from somewhere would be invented.
     */
    fun nprofile(pubkey: String, relays: List<String> = emptyList()): String {
        if (!isHex64(pubkey)) return ""
        val out = ByteArrayOutputStream()
        tlv(out, 0, hexBytes(pubkey))
        for (r in relays.filter { RELAY_HINT.matches(it) }.distinct().take(3)) tlv(out, 1, r.toByteArray())
        return Bech32.encode("nprofile", out.toByteArray())
    }

    /** nevent with author, kind and up to three relays; "" for an id that is not an event id. */
    fun nevent(id: String, author: String? = null, kind: Int? = null, relays: List<String> = emptyList()): String {
        if (!isHex64(id)) return ""
        val out = ByteArrayOutputStream()
        tlv(out, 0, hexBytes(id))
        for (r in relays.filter { RELAY_HINT.matches(it) }.distinct().take(3)) tlv(out, 1, r.toByteArray())
        if (author != null && isHex64(author)) tlv(out, 2, hexBytes(author))
        if (kind != null) tlv(out, 3, byteArrayOf((kind ushr 24).toByte(), (kind ushr 16).toByte(), (kind ushr 8).toByte(), kind.toByte()))
        return Bech32.encode("nevent", out.toByteArray())
    }

    /** Pubkey behind an npub or nprofile string, or null. */
    fun pubkeyOfProfileRef(bech32: String): String? {
        val (hrp, data) = Bech32.decode(bech32.lowercase()) ?: return null
        return when (hrp) {
            "npub" -> if (data.size == 32) hexOf(data) else null
            "nprofile" -> tlvValue(data, 0)?.takeIf { it.size == 32 }?.let(::hexOf)
            else -> null
        }
    }

    /** The event id inside a note1/nevent1 string, or null. */
    fun eventIdOf(bech32: String): String? {
        val (hrp, data) = Bech32.decode(bech32.lowercase()) ?: return null
        return when (hrp) {
            "note" -> if (data.size == 32) hexOf(data) else null
            "nevent" -> tlvValue(data, 0)?.takeIf { it.size == 32 }?.let(::hexOf)
            else -> null
        }
    }

    private fun tlvValue(data: ByteArray, type: Int): ByteArray? {
        var i = 0
        while (i + 2 <= data.size) {
            val t = data[i].toInt() and 0xff
            val len = data[i + 1].toInt() and 0xff
            if (i + 2 + len > data.size) return null
            if (t == type) return data.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
        }
        return null
    }

    /** Relay hints of an nprofile/nevent (tests and round trips). */
    fun relaysOf(bech32: String): List<String> {
        val (_, data) = Bech32.decode(bech32.lowercase()) ?: return emptyList()
        val out = mutableListOf<String>()
        var i = 0
        while (i + 2 <= data.size) {
            val t = data[i].toInt() and 0xff
            val len = data[i + 1].toInt() and 0xff
            if (i + 2 + len > data.size) break
            if (t == 1) out += String(data.copyOfRange(i + 2, i + 2 + len))
            i += 2 + len
        }
        return out
    }
}
