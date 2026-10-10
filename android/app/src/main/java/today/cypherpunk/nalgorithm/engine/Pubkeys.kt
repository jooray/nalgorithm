package today.cypherpunk.nalgorithm.engine

import today.cypherpunk.nalgorithm.model.EmbeddedPost

/**
 * Which pubkeys a set of posts needs profiles for (lib pubkeys.ts). A boost's
 * author is the booster; the writer only appears inside originalPost.
 */
object Pubkeys {
    /** Upper bound on profiles requested per feed, so one busy feed stays cheap. */
    const val MAX_PROFILE_PUBKEYS = 400

    private val REF = Regex("nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)", RegexOption.IGNORE_CASE)

    /** Hex pubkeys named by `nostr:npub1...` / `nostr:nprofile1...` references in text. */
    fun extractReferencedPubkeys(content: String, out: MutableSet<String> = LinkedHashSet()): MutableSet<String> {
        for (m in REF.findAll(content)) {
            try {
                when (val d = Nip19.decode(m.groupValues[1].lowercase())) {
                    is Nip19.Decoded.Npub -> out.add(d.pubkey)
                    is Nip19.Decoded.Nprofile -> out.add(d.pubkey)
                    else -> Unit
                }
            } catch (_: Exception) {
                // Malformed reference: nothing to look up.
            }
        }
        return out
    }

    /** The parts of a post this needs. */
    data class PostLike(val author: String, val content: String, val originalPost: EmbeddedPost? = null, val quotedPost: EmbeddedPost? = null)

    /**
     * Every pubkey worth a profile lookup: authors first (post, original, quoted),
     * then people mentioned in the text. The cap trims the mentions, never the authors.
     */
    fun collectPostPubkeys(posts: List<PostLike>, cap: Int = MAX_PROFILE_PUBKEYS): List<String> {
        val authors = LinkedHashSet<String>()
        val mentioned = LinkedHashSet<String>()
        for (p in posts) {
            authors.add(p.author)
            p.originalPost?.let { authors.add(it.author) }
            p.quotedPost?.let { authors.add(it.author) }
            extractReferencedPubkeys(p.content, mentioned)
            p.originalPost?.let { extractReferencedPubkeys(it.content, mentioned) }
            p.quotedPost?.let { extractReferencedPubkeys(it.content, mentioned) }
        }
        val all = authors.toMutableList()
        for (pk in mentioned) if (pk !in authors) all.add(pk)
        return all.take(cap)
    }

    fun ofFetched(posts: List<FetchedPost>, cap: Int = MAX_PROFILE_PUBKEYS) =
        collectPostPubkeys(posts.map { PostLike(it.author, it.content, it.originalPost, it.quotedPost) }, cap)

    fun ofScored(posts: List<today.cypherpunk.nalgorithm.model.ScoredPost>, cap: Int = MAX_PROFILE_PUBKEYS) =
        collectPostPubkeys(posts.map { PostLike(it.author, it.content, it.originalPost, it.quotedPost) }, cap)
}
