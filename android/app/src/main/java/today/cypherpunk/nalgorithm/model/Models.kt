package today.cypherpunk.nalgorithm.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Data shared by every part of the app: the Kotlin shapes of lib/src/types.ts,
 * lib/src/media.ts, lib/src/feedback.ts and web/src/digest-model.ts. Field names
 * follow the TypeScript ones, so JSON from the hosted server and from exports of
 * the web app reads straight into them.
 */

/** A signed nostr event (NIP-01). Field names are the wire names. */
@Serializable
data class NostrEvent(
    val id: String,
    val pubkey: String,
    @SerialName("created_at") val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>> = emptyList(),
    val content: String = "",
    val sig: String = "",
) {
    fun tag(name: String): String? = tags.firstOrNull { it.size > 1 && it[0] == name }?.get(1)
}

@Serializable
enum class AppMode { @SerialName("hosted") Hosted, @SerialName("byok") Byok }

@Serializable
enum class PostType { @SerialName("original") Original, @SerialName("quote") Quote, @SerialName("boost") Boost }

@Serializable
data class EmbeddedPost(val id: String, val author: String, val content: String)

/** NIP-92 `imeta` media. Only http(s) URLs are ever kept. */
@Serializable
data class MediaMeta(
    val url: String,
    val width: Int? = null,
    val height: Int? = null,
    val alt: String? = null,
    val mime: String? = null,
)

/**
 * A post as ranked: FetchedPost + score. [rawEvent] is null for hosted posts
 * (the server strips it and sends [media] instead); BYOK posts carry it.
 */
@Serializable
data class ScoredPost(
    val id: String,
    val type: PostType,
    val author: String,
    val content: String,
    val createdAt: Long,
    val quotedPost: EmbeddedPost? = null,
    val originalPost: EmbeddedPost? = null,
    val score: Double = 5.0,
    val justification: String? = null,
    val defaultScore: Boolean = false,
    val media: List<MediaMeta>? = null,
    /** Hosted: arrived since the reader last looked. */
    val isNew: Boolean = false,
    val rawEvent: NostrEvent? = null,
)

/** Kind 0 metadata, trimmed to what the app renders and needs for zaps. */
@Serializable
data class ProfileData(
    val pubkey: String,
    val name: String? = null,
    val picture: String? = null,
    val nip05: String? = null,
    val lud16: String? = null,
    val lud06: String? = null,
)

/** Profile fields kept with a digest so its notes render without a network. */
@Serializable
data class ProfileSnapshot(val name: String? = null, val picture: String? = null, val nip05: String? = null)

/** One note a digest was composed from ("show notes"). */
@Serializable
data class DigestSourceNote(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val content: String,
    val score: Double,
    val reason: String? = null,
    val kind: Int? = null,
    val relay: String? = null,
)

@Serializable
data class DigestRecord(
    /** Server id (hosted) or `local-<ms>` (bring your own key). */
    val id: String,
    val createdAt: Long,
    val text: String,
    val audioUrl: String? = null,
    val durationSeconds: Double? = null,
    /** null = not loaded / not known, distinct from an empty list. */
    val notes: List<DigestSourceNote>? = null,
    val profiles: Map<String, ProfileSnapshot>? = null,
)

@Serializable
data class FeedbackRule(val kind: String, val excerpt: String) {
    companion object {
        const val MORE = "more"
        const val LESS = "less"
    }
}
