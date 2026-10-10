package today.cypherpunk.nalgorithm.engine

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

/** lib/src/ranking-context.ts */
object RankingContext {
    /**
     * A SHA-256 content fingerprint; no event is signed or published. Never includes API keys.
     * The same bytes as nostr-tools' getEventHash over a kind-1 event whose content is the
     * JSON of [value], so the web app and this one agree on every key.
     */
    fun fingerprint(value: JsonElement): String {
        val serialized = "[0,\"${"0".repeat(64)}\",0,1,[],${Js.quote(Js.stringify(value))}]"
        val digest = MessageDigest.getInstance("SHA-256").digest(serialized.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** Learned taste evolves prospectively. Explicit policy/model changes invalidate existing scores. */
    fun rankingContext(
        userPrompt: String,
        model: String,
        scorer: String? = null,
        apiBaseUrl: String? = null,
        learnFromLikes: Boolean? = null,
    ): String = fingerprint(
        JsonArray(
            listOf(
                JsonPrimitive("ranking-v2"),
                JsonPrimitive(userPrompt.trim()),
                JsonPrimitive(scorer ?: "chat"),
                JsonPrimitive(model.trim()),
                JsonPrimitive(apiBaseUrl?.replace(Regex("/+$"), "") ?: ""),
                JsonPrimitive(learnFromLikes != false),
            ),
        ),
    )

    fun contextualScoreKey(id: String, context: String?): String =
        if (context.isNullOrEmpty()) id else fingerprint(JsonArray(listOf(JsonPrimitive(context), JsonPrimitive(id))))
}
