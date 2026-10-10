package today.cypherpunk.nostrsignin

import java.security.MessageDigest

/**
 * An unsigned nostr event with its NIP-01 id. The id is computed here, so a
 * signer that answers with only a signature still yields a complete event, and a
 * signer that answers with a whole event can be checked against what we asked
 * it to sign.
 */
data class UnsignedEvent(
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
) {
    /** sha256 of the NIP-01 serialization `[0,pubkey,created_at,kind,tags,content]`. */
    val id: String by lazy {
        val serialized = buildString {
            append("[0,").append(quote(pubkey)).append(',').append(createdAt).append(',').append(kind).append(',')
            append(tagsJson()).append(',').append(quote(content)).append(']')
        }
        Hex.encode(MessageDigest.getInstance("SHA-256").digest(serialized.toByteArray(Charsets.UTF_8)))
    }

    /** The event as the signer expects it (`id` included, no `sig`). */
    fun toJson(): String = json(sig = null)

    fun signedJson(sig: String): String = json(sig)

    private fun json(sig: String?): String = buildString {
        append("{\"id\":").append(quote(id))
        append(",\"pubkey\":").append(quote(pubkey))
        append(",\"created_at\":").append(createdAt)
        append(",\"kind\":").append(kind)
        append(",\"tags\":").append(tagsJson())
        append(",\"content\":").append(quote(content))
        if (sig != null) append(",\"sig\":").append(quote(sig))
        append('}')
    }

    private fun tagsJson(): String = tags.joinToString(",", "[", "]") { tag -> tag.joinToString(",", "[", "]") { quote(it) } }

    companion object {
        const val KIND_CLIENT_AUTH = 22242

        /**
         * The login proof a server's challenge asks for: kind 22242 (NIP-42
         * style), empty content, `challenge` and `domain` tags. The domain binds
         * the proof to the server that issued the challenge.
         */
        fun loginProof(pubkeyHex: String, challenge: String, domain: String, createdAt: Long = System.currentTimeMillis() / 1000) =
            UnsignedEvent(pubkeyHex, createdAt, KIND_CLIENT_AUTH, listOf(listOf("challenge", challenge), listOf("domain", domain)), "")

        /** NIP-01 string escaping: only `"`, `\` and control characters. */
        internal fun quote(value: String): String = buildString {
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
    }
}
