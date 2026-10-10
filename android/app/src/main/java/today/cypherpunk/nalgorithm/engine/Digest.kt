package today.cypherpunk.nalgorithm.engine

import today.cypherpunk.nalgorithm.model.DigestSourceNote
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.time.Instant
import java.time.ZoneId
import kotlin.math.roundToLong

/**
 * Digest writing (lib digest.ts): scored posts into a spoken-word narrative.
 * The prompts are the library's, word for word, so every client writes alike.
 */
object DigestWriter {
    const val DEFAULT_DIGEST_SYSTEM_PROMPT = "You are a witty, knowledgeable radio host delivering a spoken-word digest of what happened on Nostr in the last 24 hours. Always open with \"Good morning, nostrich!\" Your style is conversational, warm, and engaging — like a smart friend catching you up over coffee. You weave posts together into a narrative rather than reading them one by one. Add context, make connections between topics, and keep the energy up. Aim for about 6 minutes of spoken content (roughly 1100-1500 words): never pad, and keep every item tight."

    const val DEFAULT_DIGEST_PROMPT = "Create a spoken-word radio digest from these top Nostr posts. Group related topics together, add transitions, and make it flow naturally as if someone is listening to it being read aloud. Don't just list posts — tell the story of what happened today. Include attribution (mention who said what) but keep it natural. Skip any posts that are too short or low-quality to be worth mentioning."

    /** Always appended to the system prompt: corrections to how these models write by default. */
    const val HUMANIZER_APPENDIX = """
WRITING STYLE (mandatory — apply before finalizing):
- No significance inflation: avoid "pivotal", "testament", "evolving landscape", "underscores", "enduring"
- No promotional language: avoid "groundbreaking", "vibrant", "stunning", "nestled", "breathtaking"
- No vague attributions: avoid "experts believe", "observers note", "industry reports suggest"
- No superficial -ing phrases tacked on for fake depth: avoid "highlighting...", "showcasing...", "reflecting...", "contributing to..."
- No em dash overuse — prefer commas or short sentences
- No staccato "Not X. Not Y." contrast pattern
- No copula avoidance: use "is"/"are" instead of "serves as", "stands as", "functions as"
- No filler: cut "In order to", "At this point in time", "It is important to note that"
- No generic upbeat conclusions: avoid "the future looks bright", "exciting times ahead", "continuing this journey"
- No rule of three where it feels forced
- Vary sentence length. Short punchy ones. Then longer ones that take their time. Mix them.
- Have opinions. React to things. Be specific rather than vague."""

    /** For output that goes straight into a speech engine. */
    const val SPEECH_APPENDIX = """

SPOKEN OUTPUT (this will be read aloud by a text-to-speech engine):
- Output ONLY plain text. No markdown, no headers, no bullet points, no asterisks.
- Spell out version numbers: "one dot five dot three" not "1.5.3"
- Spell out abbreviations on first use: "N I P nineteen" not "NIP-19"
- Write URLs as spoken descriptions: "on their GitHub" not "github.com/foo/bar"
- No hashtags, no emoji, no special unicode characters.
- Use short paragraphs separated by blank lines as natural pause points."""

    /** Cheaper models drift without these: they drop posts and adopt authors' claims as their own. */
    const val FAITHFULNESS_RULES = "Additional rules: give every post in the list at least one sentence, most important first, and group related ones. Report what people said and attribute it to them; do not add opinions of your own on contested political or legal matters, and do not state anything the posts do not say."

    /** Closing line for a spoken digest, so the listener knows it is over. */
    const val SPOKEN_SIGN_OFF = "End with the sentence: That's your digest."

    const val DIGEST_NOTE_MAX_CHARS = 1500

    private const val DEFAULT_LENGTH_SENTENCE = "Aim for about 6 minutes of spoken content (roughly 1100-1500 words): never pad, and keep every item tight."

    /** Spoken English runs at about 160 to 200 words a minute. */
    fun digestWordRange(minutes: Int): Pair<Int, Int> {
        val m = minutes.coerceIn(1, 15)
        return ((m * 160) / 50.0).roundToLong().toInt() * 50 to ((m * 200) / 50.0).roundToLong().toInt() * 50
    }

    private fun lengthSentence(minutes: Int): String {
        val (lo, hi) = digestWordRange(minutes)
        return "Aim for at most about $minutes minutes of spoken content (roughly $lo-$hi words). If there is less worth saying, be shorter: never pad, and keep every item tight."
    }

    /** The humanizer rules are appended whether or not the caller supplied its own prompt. */
    fun buildDigestSystemPrompt(custom: String? = null, forSpeech: Boolean = false, targetMinutes: Int? = null): String {
        var base = custom ?: DEFAULT_DIGEST_SYSTEM_PROMPT
        if (targetMinutes != null && custom == null) base = base.replace(DEFAULT_LENGTH_SENTENCE, lengthSentence(targetMinutes))
        return base + HUMANIZER_APPENDIX + if (forSpeech) SPEECH_APPENDIX else ""
    }

    /** Never a key: a speech engine would read it out character by character. */
    private fun resolveAuthorName(pubkey: String, profiles: Map<String, ProfileData>?): String =
        profiles?.get(pubkey)?.name?.takeIf { it.isNotEmpty() } ?: "someone you follow"

    /** "3:05 PM", as en-US toLocaleTimeString prints it. */
    internal fun clockTime(unixSeconds: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val t = Instant.ofEpochSecond(unixSeconds).atZone(zone)
        val hour = t.hour % 12
        return "${if (hour == 0) 12 else hour}:${"%02d".format(t.minute)} ${if (t.hour < 12) "AM" else "PM"}"
    }

    /** One scored post for the prompt, with its score and the ranker's reason. */
    fun formatPostForDigest(post: ScoredPost, index: Int, profiles: Map<String, ProfileData>? = null, zone: ZoneId = ZoneId.systemDefault()): String {
        val authorName = resolveAuthorName(post.author, profiles)
        val justification = post.justification ?: ""
        val time = clockTime(post.createdAt, zone)
        val original = post.originalPost
        val quoted = post.quotedPost
        var content = when {
            post.type == PostType.Boost && original != null ->
                "[Boosted by $authorName] Originally by ${resolveAuthorName(original.author, profiles)}: ${original.content}"
            post.type == PostType.Quote && quoted != null ->
                "$authorName quoted ${resolveAuthorName(quoted.author, profiles)}: \"${post.content}\" — Original: \"${quoted.content}\""
            else -> "$authorName: ${post.content}"
        }
        if (content.length > 800) content = content.substring(0, 800) + "..."
        return "${index + 1}. [Score: ${Js.number(post.score)}/10, $time] $content${if (justification.isNotEmpty()) "\n   Relevance: $justification" else ""}"
    }

    /** One real relevance judgment per unique note; boosts take no extra slots, fallbacks none at all. */
    fun selectDigestPosts(posts: List<ScoredPost>, topN: Int = 15): List<ScoredPost> {
        val seen = HashSet<String>()
        return Scoring.sortByRelevance(posts).filter { post ->
            val key = Scoring.scoreCacheKey(post)
            if (post.defaultScore || key in seen) false else seen.add(key)
        }.take(topN.coerceIn(1, 50))
    }

    /**
     * The notes a digest is composed from, in prompt order. A boost is represented by the
     * note it reposted; a quote by the quoting note itself.
     */
    fun digestSourceNotes(posts: List<ScoredPost>, topN: Int = 15): List<DigestSourceNote> =
        selectDigestPosts(posts, topN).map { post ->
            val boost = if (post.type == PostType.Boost) post.originalPost else null
            DigestSourceNote(
                id = boost?.id ?: post.id,
                pubkey = boost?.author ?: post.author,
                createdAt = post.createdAt,
                content = (boost?.content ?: post.content).take(DIGEST_NOTE_MAX_CHARS),
                score = post.score,
                reason = post.justification?.takeIf { it.isNotEmpty() },
                kind = if (boost == null) post.rawEvent?.kind else null,
            )
        }

    data class Options(
        val posts: List<ScoredPost>,
        val profiles: Map<String, ProfileData>? = null,
        val userPrompt: String,
        val learnedPrompt: String? = null,
        val systemPrompt: String? = null,
        val digestPrompt: String? = null,
        val topN: Int = 15,
        /** The reader's 3/6/10-minute choice: an upper bound, never padded to. */
        val targetMinutes: Int? = null,
        val forSpeech: Boolean = false,
        val faithfulness: Boolean = true,
        val temperature: Double = 0.5,
        /** Supplying this streams the digest (and skips the retry wrapper: a restart would duplicate text). */
        val onDelta: ((String) -> Unit)? = null,
        val zone: ZoneId = ZoneId.systemDefault(),
    )

    /** The chat messages for a digest run, without sending them. */
    fun buildDigestMessages(o: Options): List<ChatMessage> {
        val topPosts = selectDigestPosts(o.posts, o.topN)
        val postsBlock = topPosts.mapIndexed { i, p -> formatPostForDigest(p, i, o.profiles, o.zone) }.joinToString("\n\n")
        val learned = if (!o.learnedPrompt.isNullOrEmpty()) "\n=== Learned Preferences ===\n${o.learnedPrompt}" else ""
        val rules = if (!o.faithfulness) "" else "\n\n$FAITHFULNESS_RULES${if (o.forSpeech) " $SPOKEN_SIGN_OFF" else ""}"
        val userMessage = "${o.digestPrompt ?: DEFAULT_DIGEST_PROMPT}\n\n" +
            "=== User's Interests ===\n${o.userPrompt}\n$learned\n\n" +
            "=== Top ${topPosts.size} Posts (ranked by relevance) ===\n\n$postsBlock$rules"
        return listOf(
            ChatMessage("system", buildDigestSystemPrompt(o.systemPrompt, o.forSpeech, o.targetMinutes)),
            ChatMessage("user", userMessage),
        )
    }

    /** Write a digest. Usually with a stronger model than the scorer: it runs once over ~15 posts. */
    suspend fun generateDigest(config: LlmConfig, o: Options): String {
        if (o.posts.isEmpty()) throw Exception("Nothing to summarize — no scored posts")
        val messages = buildDigestMessages(o)
        if (selectDigestPosts(o.posts, o.topN).isEmpty()) throw Exception("No successfully ranked notes yet. Fix the model connection and rank again.")
        val onDelta = o.onDelta
        return if (onDelta != null) {
            chatCompletionStream(config, messages, onDelta, o.temperature)
        } else {
            chatCompletionWithRetry(config, messages, false, 3, 2000, o.temperature)
        }
    }
}
