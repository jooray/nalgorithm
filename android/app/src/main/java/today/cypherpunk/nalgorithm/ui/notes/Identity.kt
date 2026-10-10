package today.cypherpunk.nalgorithm.ui.notes

import androidx.compose.runtime.Immutable
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost

/**
 * Port of web/src/identity.ts: who a post is by, and how boosts fold into it.
 * Rule: nothing user-facing ever shows a hex key. A person is either a profile
 * name or their npub.
 */

private val HEX_64_ANY_CASE = Regex("^[0-9a-f]{64}$", RegexOption.IGNORE_CASE)

/** The profile's name, unless it is missing or is itself a bare key. */
fun profileName(profile: ProfileData?): String? {
    val name = profile?.name?.trim()
    if (name.isNullOrEmpty() || HEX_64_ANY_CASE.matches(name)) return null
    return name
}

@Immutable
data class AuthorLabel(
    /** A profile name, or the complete npub. */
    val text: String,
    /** True when [text] is an npub, so the view can use a monospace, ellipsised style. */
    val isNpub: Boolean,
)

/** Name if known, otherwise the full npub (truncation is the view's job, so copy gets everything). */
fun authorLabel(pubkey: String, profile: ProfileData?): AuthorLabel {
    val name = profileName(profile)
    if (name != null) return AuthorLabel(name, false)
    return AuthorLabel(NoteIds.npub(pubkey), true)
}

/** A short form for sheets and lists: the name, or `npub1abcdefgh…wxyz`. */
fun shortName(pubkey: String, profile: ProfileData?): String {
    val label = authorLabel(pubkey, profile)
    return if (label.isNpub && label.text.length > 16) "${label.text.take(12)}…${label.text.takeLast(4)}" else label.text
}

/** One letter for an avatar placeholder, or a neutral glyph when the name is unknown. */
fun avatarInitial(profile: ProfileData?): String {
    val name = profileName(profile) ?: return "?"
    var i = 0
    while (i < name.length) {
        val cp = name.codePointAt(i)
        if (Character.isLetterOrDigit(cp)) return String(Character.toChars(cp)).uppercase()
        i += Character.charCount(cp)
    }
    return "?"
}

/** The grey handle next to a name: the profile's NIP-05, without the `_@` of a root identifier. */
fun handleOf(profile: ProfileData?): String = profile?.nip05?.trim()?.removePrefix("_@").orEmpty()

// ─── Boost folding ───────────────────────────────────────────────────────────

/** A post as displayed: boosts are folded into the note, [boostedBy] lists the boosters in the order first seen. */
@Immutable
data class DisplayPost(val post: ScoredPost, val boostedBy: List<String> = emptyList()) {
    val id: String get() = post.id
}

/**
 * Fold boosts into the note they boost.
 *
 * A boost has no commentary of its own, so it should never be a card of its
 * own. Grouping uses the same key as the score cache (the boosted event's id
 * for a boost, the post's own id otherwise), which means:
 *
 *  - a note and boosts of it become one card showing the note, with `boostedBy`;
 *  - several boosts of a note not itself in the list become one card built from
 *    the embedded original (author, text and id are the original's);
 *  - quote posts stay as they are, and a boost of a quote folds into the quote.
 *
 * Score: the highest of the group wins, with its justification. Time: the note's
 * own when it is in the list, else the most recent boost's. Order: first
 * appearance, except that a merge that raised a score re-sorts stably by score.
 */
fun aggregateBoosts(posts: List<ScoredPost>): List<DisplayPost> {
    val out = ArrayList<ScoredPost>()
    val boosters = ArrayList<MutableList<String>>()
    val byKey = HashMap<String, Int>()
    val synthesized = HashSet<String>()
    var scoreRaised = false

    fun adopt(entry: ScoredPost, from: ScoredPost): ScoredPost {
        if (from.score <= entry.score) return entry
        scoreRaised = true
        return entry.copy(score = from.score, justification = from.justification, defaultScore = from.defaultScore)
    }

    for (post in posts) {
        val orig = post.originalPost
        val foldable = post.type == PostType.Boost && orig != null && orig.id.isNotEmpty()
        val key = if (foldable) orig.id else post.id
        val at = byKey[key]
        if (at == null) {
            byKey[key] = out.size
            if (foldable) {
                synthesized += key
                out += post.copy(
                    id = orig.id, type = PostType.Original, author = orig.author, content = orig.content,
                    originalPost = null, quotedPost = null, rawEvent = null,
                )
                boosters.add(mutableListOf(post.author))
            } else {
                out += post
                boosters.add(mutableListOf())
            }
            continue
        }
        val entry = out[at]
        if (foldable) {
            if (post.author !in boosters[at]) boosters[at].add(post.author)
            var next = entry
            if (key in synthesized && post.createdAt > entry.createdAt) next = next.copy(createdAt = post.createdAt)
            out[at] = adopt(next, post)
        } else if (key in synthesized) {
            // The note itself turned up after boosts of it: it replaces the stand-in.
            out[at] = adopt(post, entry)
            synthesized -= key
        } else {
            out[at] = adopt(entry, post) // the same note listed twice
        }
    }

    val folded = out.mapIndexed { i, p -> DisplayPost(p, boosters[i].toList()) }
    if (!scoreRaised) return folded
    return folded.withIndex().sortedWith(compareByDescending<IndexedValue<DisplayPost>> { it.value.post.score }.thenBy { it.index }).map { it.value }
}

/** Up to four names in full; beyond that the first three and the rest behind "and N more". */
fun summarizeBoosters(pubkeys: List<String>): Pair<List<String>, List<String>> =
    if (pubkeys.size <= 4) pubkeys to emptyList() else pubkeys.take(3) to pubkeys.drop(3)

// ─── Content tokens ──────────────────────────────────────────────────────────

sealed interface ContentToken {
    data class Text(val text: String) : ContentToken
    data class Profile(val bech32: String, val pubkey: String?) : ContentToken
    data class Ref(val bech32: String) : ContentToken
    data class Url(val url: String, val trailing: String) : ContentToken
}

private val TOKEN_PATTERN = Regex(
    "nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+|n(?:event|ote|addr)1[a-z0-9]+)|https?://\\S+",
    RegexOption.IGNORE_CASE,
)
private val TRAILING_BRACKETS = Regex("[)>]+$")

/** Split post text into plain text, profile mentions, event references and URLs. */
fun tokenizeContent(content: String): List<ContentToken> {
    val tokens = ArrayList<ContentToken>()
    var last = 0
    for (m in TOKEN_PATTERN.findAll(content)) {
        val at = m.range.first
        if (at > last) tokens += ContentToken.Text(content.substring(last, at))
        val whole = m.value
        val bech32 = m.groups[1]?.value
        if (bech32 != null) {
            tokens += if (bech32.startsWith("npub1", true) || bech32.startsWith("nprofile1", true)) {
                ContentToken.Profile(bech32, NoteIds.pubkeyOfProfileRef(bech32))
            } else {
                ContentToken.Ref(bech32)
            }
        } else {
            val url = whole.replace(TRAILING_BRACKETS, "")
            tokens += ContentToken.Url(url, whole.substring(url.length))
        }
        last = m.range.last + 1
    }
    if (last < content.length) tokens += ContentToken.Text(content.substring(last))
    return tokens
}

/** Every pubkey a card names (author, boosters, quoted author and @mentions): lazy-profiles.ts peopleOf. */
fun peopleOf(display: DisplayPost): List<String> {
    val out = LinkedHashSet<String>()
    fun add(pk: String?) { if (NoteIds.isHex64(pk)) out += pk!! }
    val p = display.post
    add(p.author)
    display.boostedBy.forEach(::add)
    add(p.originalPost?.author)
    add(p.quotedPost?.author)
    for (text in listOfNotNull(p.content, p.originalPost?.content, p.quotedPost?.content)) {
        for (t in tokenizeContent(text)) if (t is ContentToken.Profile) add(t.pubkey)
    }
    return out.toList()
}
