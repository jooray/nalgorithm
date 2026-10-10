package today.cypherpunk.nalgorithm.hosted

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nostrsignin.Bech32

/**
 * The last ranking, kept on this device per account (web LocalSnapshot), so the app
 * opens with something to read, also offline.
 */
@Serializable
data class HostedSnapshot(
    val v: Int = 1,
    /** Unix seconds of the run the ranking came from. */
    val createdAt: Long,
    val hoursBack: Int? = null,
    val fetched: Int? = null,
    /** Notes (folded ids) that came with this run and were not in the one before. */
    val fresh: List<String> = emptyList(),
    val posts: List<ScoredPost>,
    val profiles: Map<String, ProfileData> = emptyMap(),
)

private val MENTION = Regex("nostr:(npub1[02-9ac-hj-np-z]+|nprofile1[02-9ac-hj-np-z]+)", RegexOption.IGNORE_CASE)

/** Authors, quoted and boosted authors, and people mentioned in the text: whose profiles a post needs. */
fun postPubkeys(post: ScoredPost): Set<String> {
    val out = LinkedHashSet<String>()
    out += post.author
    post.quotedPost?.author?.let { out += it }
    post.originalPost?.author?.let { out += it }
    val texts = listOfNotNull(post.content, post.quotedPost?.content, post.originalPost?.content)
    for (text in texts) for (m in MENTION.findAll(text)) mentionHex(m.groupValues[1])?.let { out += it }
    return out
}

private fun mentionHex(id: String): String? {
    Bech32.pubkeyHex(id)?.let { return it }
    // nprofile: TLV, type 0 is the 32-byte pubkey.
    val (hrp, bytes) = Bech32.decode(id) ?: return null
    if (hrp != "nprofile") return null
    var i = 0
    while (i + 2 <= bytes.size) {
        val type = bytes[i].toInt() and 0xff
        val len = bytes[i + 1].toInt() and 0xff
        if (i + 2 + len > bytes.size) return null
        if (type == 0 && len == 32) return bytes.copyOfRange(i + 2, i + 34).joinToString("") { "%02x".format(it) }
        i += 2 + len
    }
    return null
}

/**
 * Fit a snapshot under the caps. Posts are in rank order, so the tail goes first;
 * only the profiles the kept posts need stay.
 */
fun trimSnapshot(snap: HostedSnapshot, maxBytes: Int = LOCAL_MAX_BYTES, maxPosts: Int = LOCAL_MAX_POSTS): HostedSnapshot {
    val posts = snap.posts.take(maxPosts)
    var total = AppJson.encodeToString(HostedSnapshot.serializer(), snap.copy(posts = emptyList(), profiles = emptyMap())).length
    val people = HashSet<String>()
    var kept = 0
    for (post in posts) {
        val added = postPubkeys(post).filter { it !in people && it in snap.profiles }
        val size = AppJson.encodeToString(ScoredPost.serializer(), post).length + 1 +
            added.sumOf { AppJson.encodeToString(String.serializer(), it).length + AppJson.encodeToString(ProfileData.serializer(), snap.profiles.getValue(it)).length + 2 }
        if (total + size > maxBytes) break
        total += size
        kept++
        people += added
    }
    return snap.copy(posts = posts.take(kept), profiles = snap.profiles.filterKeys { it in people })
}
