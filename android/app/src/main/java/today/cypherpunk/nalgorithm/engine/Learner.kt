package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CancellationException

/** Summarizes liked posts into a learned preference prompt (lib learner.ts). */
class Learner(private val llm: LlmConfig) {
    companion object {
        const val SYSTEM_PROMPT = "You are an analyst that summarizes user preferences based on their social media engagement. Be concise and specific. Output only the summary text, no JSON, no markdown formatting."

        private fun stripNostrRefs(content: String): String =
            content.replace(Regex("nostr:n(event|ote|pub|profile|addr)1[a-z0-9]+", RegexOption.IGNORE_CASE), "").trim()

        internal fun buildSummarizationPrompt(posts: List<LikedPostContent>): String {
            val postList = posts.mapIndexed { i, p -> "${i + 1}. \"${Scoring.truncate(stripNostrRefs(p.content), 300)}\"" }.joinToString("\n")
            return """Analyze these Nostr posts that a user has liked/reacted positively to. Based on these posts, summarize the user's interests, preferences, and the types of content they engage with.

Be specific about:
- Topics they care about
- Tone and style they prefer (philosophical, technical, casual, etc.)
- Types of content (longform, short thoughts, links, media, etc.)
- Any recurring themes

Write 2-4 concise sentences. Do not list the posts back. Just describe the user's taste.

Liked posts:
$postList

Summary:"""
        }
    }

    /** At most 100 likes, to stay inside context limits. Failures return "". */
    suspend fun summarizeLikes(likedPosts: List<LikedPostContent>): String {
        if (likedPosts.isEmpty()) return ""
        return try {
            chatCompletionWithRetry(
                llm,
                listOf(ChatMessage("system", SYSTEM_PROMPT), ChatMessage("user", buildSummarizationPrompt(likedPosts.take(100)))),
            ).trim()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            ""
        }
    }
}
