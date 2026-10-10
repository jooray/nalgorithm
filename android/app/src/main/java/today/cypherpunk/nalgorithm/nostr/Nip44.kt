package today.cypherpunk.nalgorithm.nostr

import fr.acinq.secp256k1.Secp256k1
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * NIP-44 v2: the encryption NIP-46 frames use. A straight port of the spec
 * (secp256k1 ECDH, HKDF-SHA256, ChaCha20, HMAC-SHA256, padded plaintext),
 * tested against the official vectors.
 */
object Nip44 {
    private const val VERSION = 2
    private val SALT = "nip44-v2".toByteArray(Charsets.US_ASCII)
    const val MIN_PLAINTEXT = 1
    const val MAX_PLAINTEXT = 65535

    class Nip44Exception(message: String) : Exception(message)

    /** The conversation key between [secret] (32 bytes) and the x-only [pubHex]. */
    fun conversationKey(secret: ByteArray, pubHex: String): ByteArray {
        if (secret.size != 32 || !Secp256k1.secKeyVerify(secret)) throw Nip44Exception("invalid secret key")
        if (!Hex.isHex64(pubHex.lowercase())) throw Nip44Exception("invalid public key")
        val shared = try {
            Keys.sharedX(secret, pubHex.lowercase())
        } catch (e: Exception) {
            throw Nip44Exception("invalid public key")
        }
        return hmac(SALT, shared)
    }

    class MessageKeys(val chachaKey: ByteArray, val chachaNonce: ByteArray, val hmacKey: ByteArray)

    fun messageKeys(conversationKey: ByteArray, nonce: ByteArray): MessageKeys {
        if (conversationKey.size != 32) throw Nip44Exception("invalid conversation key")
        if (nonce.size != 32) throw Nip44Exception("invalid nonce")
        val okm = hkdfExpand(conversationKey, nonce, 76)
        return MessageKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 44), okm.copyOfRange(44, 76))
    }

    fun calcPaddedLen(unpaddedLen: Int): Int {
        if (unpaddedLen <= 0) throw Nip44Exception("invalid plaintext length")
        if (unpaddedLen <= 32) return 32
        val nextPower = 1 shl (31 - Integer.numberOfLeadingZeros(unpaddedLen - 1) + 1)
        val chunk = if (nextPower <= 256) 32 else nextPower / 8
        return chunk * ((unpaddedLen - 1) / chunk + 1)
    }

    private fun pad(plaintext: String): ByteArray {
        val bytes = plaintext.toByteArray(Charsets.UTF_8)
        val len = bytes.size
        if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw Nip44Exception("invalid plaintext length")
        val out = ByteArray(2 + calcPaddedLen(len))
        out[0] = (len ushr 8).toByte()
        out[1] = len.toByte()
        System.arraycopy(bytes, 0, out, 2, len)
        return out
    }

    private fun unpad(padded: ByteArray): String {
        val len = ((padded[0].toInt() and 0xff) shl 8) or (padded[1].toInt() and 0xff)
        if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT || padded.size != 2 + calcPaddedLen(len)) {
            throw Nip44Exception("invalid padding")
        }
        val bytes = padded.copyOfRange(2, 2 + len)
        val decoder = Charsets.UTF_8.newDecoder()
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            throw Nip44Exception("invalid utf-8")
        }
    }

    fun encrypt(plaintext: String, conversationKey: ByteArray, nonce: ByteArray = randomBytes(32)): String {
        val keys = messageKeys(conversationKey, nonce)
        val ciphertext = ChaCha20.xor(keys.chachaKey, keys.chachaNonce, pad(plaintext))
        val mac = hmac(keys.hmacKey, nonce + ciphertext)
        return Base64.getEncoder().encodeToString(byteArrayOf(VERSION.toByte()) + nonce + ciphertext + mac)
    }

    fun decrypt(payload: String, conversationKey: ByteArray): String {
        val plen = payload.length
        if (plen == 0 || payload[0] == '#') throw Nip44Exception("unknown encryption version")
        if (plen < 132 || plen > 87472) throw Nip44Exception("invalid payload size")
        val data = try {
            Base64.getDecoder().decode(payload)
        } catch (e: IllegalArgumentException) {
            throw Nip44Exception("invalid base64")
        }
        val dlen = data.size
        if (dlen < 99 || dlen > 65603) throw Nip44Exception("invalid data size")
        if (data[0].toInt() != VERSION) throw Nip44Exception("unknown encryption version ${data[0]}")
        val nonce = data.copyOfRange(1, 33)
        val ciphertext = data.copyOfRange(33, dlen - 32)
        val mac = data.copyOfRange(dlen - 32, dlen)
        val keys = messageKeys(conversationKey, nonce)
        val expected = hmac(keys.hmacKey, nonce + ciphertext)
        if (!MessageDigest.isEqual(expected, mac)) throw Nip44Exception("invalid MAC")
        return unpad(ChaCha20.xor(keys.chachaKey, keys.chachaNonce, ciphertext))
    }

    internal fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    /** RFC 5869 expand. */
    internal fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var t = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            t = hmac(prk, t + info + byteArrayOf(counter.toByte()))
            out.write(t)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }
}

/** RFC 8439 ChaCha20 with a 96-bit nonce and the block counter starting at 0. */
internal object ChaCha20 {
    private fun rotl(v: Int, c: Int) = (v shl c) or (v ushr (32 - c))

    private fun le32(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8) or
            ((b[off + 2].toInt() and 0xff) shl 16) or ((b[off + 3].toInt() and 0xff) shl 24)

    fun xor(key: ByteArray, nonce: ByteArray, input: ByteArray): ByteArray {
        require(key.size == 32 && nonce.size == 12)
        val state = IntArray(16)
        state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574
        for (i in 0 until 8) state[4 + i] = le32(key, i * 4)
        state[12] = 0
        for (i in 0 until 3) state[13 + i] = le32(nonce, i * 4)
        val out = ByteArray(input.size)
        val x = IntArray(16)
        val block = ByteArray(64)
        var offset = 0
        while (offset < input.size) {
            state.copyInto(x)
            repeat(10) {
                quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15)
                quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14)
            }
            for (i in 0 until 16) {
                val v = x[i] + state[i]
                block[i * 4] = v.toByte(); block[i * 4 + 1] = (v ushr 8).toByte()
                block[i * 4 + 2] = (v ushr 16).toByte(); block[i * 4 + 3] = (v ushr 24).toByte()
            }
            val n = minOf(64, input.size - offset)
            for (i in 0 until n) out[offset + i] = (input[offset + i].toInt() xor block[i].toInt()).toByte()
            offset += n
            state[12]++
        }
        return out
    }

    private fun quarter(x: IntArray, a: Int, b: Int, c: Int, d: Int) {
        x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 16)
        x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 12)
        x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 8)
        x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 7)
    }
}
