package today.cypherpunk.nalgorithm.engine

import today.cypherpunk.nalgorithm.model.FeedbackRule

/**
 * Private reader feedback on single notes (lib feedback.ts). It travels with the
 * learned preferences: it steers future scores without invalidating cached ones.
 */
object Feedback {
    /** How many rules reach the model, newest first; older ones stay listed but stop steering. */
    const val RULES_MAX = 20
    const val EXCERPT_MAX = 200

    /** The rules as a prompt block, or "" when there are none. */
    fun prompt(rules: List<FeedbackRule>): String {
        val lines = rules.take(RULES_MAX).mapNotNull { r ->
            val excerpt = r.excerpt.replace(Regex("${Js.WS}+"), " ").trim().take(EXCERPT_MAX)
            if (excerpt.isEmpty()) null
            else "- ${if (r.kind == FeedbackRule.MORE) "More like this" else "Less like this"}: \"$excerpt\""
        }
        if (lines.isEmpty()) return ""
        return (
            listOf(
                "=== Private feedback on specific notes ===",
                "The reader marked these notes. Score similar notes accordingly; their written interests still come first.",
            ) + lines
            ).joinToString("\n")
    }

    /** Learned preferences with the feedback block after them; null when both are empty. */
    fun withFeedback(learnedPrompt: String?, rules: List<FeedbackRule>): String? {
        val parts = listOf(learnedPrompt?.trim().orEmpty(), prompt(rules)).filter { it.isNotEmpty() }
        return if (parts.isEmpty()) null else parts.joinToString("\n\n")
    }
}
