package today.cypherpunk.nostrsignin

/** Minimal bech32 (BIP-173/NIP-19) for npub ⇄ hex. */
object Bech32 {
    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    private val GENERATORS = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)

    private fun polymod(values: IntArray): Int {
        var chk = 1
        for (v in values) {
            val top = chk ushr 25
            chk = (chk and 0x1ffffff) shl 5 xor v
            for (i in 0 until 5) if ((top ushr i) and 1 == 1) chk = chk xor GENERATORS[i]
        }
        return chk
    }

    private fun hrpExpand(hrp: String): IntArray =
        IntArray(hrp.length * 2 + 1) { i ->
            when {
                i < hrp.length -> hrp[i].code ushr 5
                i == hrp.length -> 0
                else -> hrp[i - hrp.length - 1].code and 31
            }
        }

    /** (hrp, 8-bit data), or null when [text] is not valid bech32. */
    fun decode(text: String): Pair<String, ByteArray>? {
        val s = text.trim().lowercase()
        val pos = s.lastIndexOf('1')
        if (pos < 1 || pos + 7 > s.length) return null
        val hrp = s.substring(0, pos)
        val data = IntArray(s.length - pos - 1)
        for (i in data.indices) {
            val c = CHARSET.indexOf(s[pos + 1 + i])
            if (c < 0) return null
            data[i] = c
        }
        if (polymod(hrpExpand(hrp) + data) != 1) return null
        val bytes = convertBits(data.copyOf(data.size - 6), 5, 8, pad = false) ?: return null
        return hrp to bytes.map { it.toByte() }.toByteArray()
    }

    fun encode(hrp: String, bytes: ByteArray): String {
        val data = convertBits(IntArray(bytes.size) { bytes[it].toInt() and 0xff }, 8, 5, pad = true)!!
        val values = hrpExpand(hrp) + data + IntArray(6)
        val mod = polymod(values) xor 1
        val checksum = IntArray(6) { (mod ushr (5 * (5 - it))) and 31 }
        return hrp + "1" + (data + checksum).joinToString("") { CHARSET[it].toString() }
    }

    private fun convertBits(data: IntArray, from: Int, to: Int, pad: Boolean): IntArray? {
        var acc = 0
        var bits = 0
        val out = ArrayList<Int>()
        val max = (1 shl to) - 1
        for (value in data) {
            if (value < 0 || value ushr from != 0) return null
            acc = (acc shl from) or value
            bits += from
            while (bits >= to) {
                bits -= to
                out.add((acc shr bits) and max)
            }
        }
        if (pad) {
            if (bits > 0) out.add((acc shl (to - bits)) and max)
        } else if (bits >= from || ((acc shl (to - bits)) and max) != 0) {
            return null
        }
        return out.toIntArray()
    }

    /** npub1… or 64-char hex → lowercase hex pubkey, else null. */
    fun pubkeyHex(value: String): String? {
        val v = value.trim()
        if (Hex.isHex(v, 64)) return v.lowercase()
        val (hrp, bytes) = decode(v) ?: return null
        if (hrp != "npub" || bytes.size != 32) return null
        return Hex.encode(bytes)
    }

    fun npub(pubkeyHex: String): String = encode("npub", Hex.decode(pubkeyHex))
}

internal object Hex {
    fun isHex(value: String, length: Int): Boolean =
        value.length == length && value.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    fun encode(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun decode(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
