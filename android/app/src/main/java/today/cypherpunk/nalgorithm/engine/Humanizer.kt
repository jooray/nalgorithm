package today.cypherpunk.nalgorithm.engine

import android.content.Context
import kotlinx.coroutines.CancellationException

/**
 * The humanizer pass (lib humanizer.ts): a second call over a finished digest that
 * edits out the tells of AI writing. The prompt is the vendored skill
 * (lib/skills/humanizer/SKILL.md), packaged as the asset `humanizer-skill.md`.
 */
class HumanizerSkill(val version: String, val temperature: Double, val prompt: String) {
    companion object {
        const val ASSET = "humanizer-skill.md"

        /**
         * Split the flat frontmatter exactly like scripts/sync-humanizer.mjs: not a YAML
         * parser, the keys are scalars.
         */
        fun parse(text: String): HumanizerSkill {
            require(text.startsWith("---")) { "humanizer skill: expected YAML frontmatter, got none" }
            val end = text.indexOf("\n---", 3)
            require(end != -1) { "humanizer skill: frontmatter is not terminated" }
            val frontmatter = HashMap<String, String>()
            for (line in text.substring(3, end).split('\n')) {
                val m = Regex("^([A-Za-z_][A-Za-z0-9_]*):\\s*(.*)$").find(line.trim()) ?: continue
                frontmatter[m.groupValues[1]] = m.groupValues[2].replace(Regex("^[\"']|[\"']$"), "")
            }
            val prompt = text.substring(end + 4).trim()
            val version = frontmatter["version"]
            require(!version.isNullOrEmpty()) { "humanizer skill: frontmatter has no \"version\"" }
            require(prompt.isNotEmpty()) { "humanizer skill: no prompt body below the frontmatter" }
            val temperature = frontmatter["temperature"]?.let { it.trim().ifEmpty { "0" }.toDoubleOrNull() } ?: 0.4
            return HumanizerSkill(version, temperature, prompt)
        }

        @Volatile private var cached: HumanizerSkill? = null

        fun load(context: Context): HumanizerSkill = cached ?: context.assets.open(ASSET).use {
            parse(it.readBytes().toString(Charsets.UTF_8))
        }.also { cached = it }
    }
}

object Humanizer {
    /** The skill is written for a page; a spoken digest must stay speakable. */
    private const val SPEECH_CONSTRAINTS = """
This text is about to be read aloud by a speech engine, so the rewrite must stay speakable:
- Plain text only. No markdown, no headings, no bullet points, no asterisks, no emoji.
- Keep numbers, versions and abbreviations spelled out the way the draft spells them.
- Keep URLs as spoken descriptions, never as addresses.
- Keep short paragraphs separated by blank lines; they are the reader's pauses."""

    fun buildMessages(skill: HumanizerSkill, text: String, forSpeech: Boolean = false): List<ChatMessage> {
        val instructions = listOf(
            "Rewrite the text below following your editing rules.",
            "Return only the rewritten text: no preamble, no notes on what you changed, no labels.",
            if (forSpeech) SPEECH_CONSTRAINTS else "",
        ).filter { it.isNotEmpty() }.joinToString("\n")
        return listOf(ChatMessage("system", skill.prompt), ChatMessage("user", "$instructions\n\n$text"))
    }

    /** Strip the wrapper a model adds when it ignores "return only the text". */
    internal fun unwrap(text: String): String {
        var out = text.trim()
        Regex("^```[a-zA-Z]*\n([\\s\\S]*)\n```$").find(out)?.let { out = it.groupValues[1].trim() }
        // A single leading label line, matched narrowly: a digest may open with a short line ending in a colon.
        out = out.replaceFirst(
            Regex("^[^\n]{0,60}\\b(?:rewrite|revised text|revised version|final version|humanized text)\\b[^\n]{0,20}:[ \t]*\n+", RegexOption.IGNORE_CASE),
            "",
        )
        return out.trim()
    }

    /**
     * Rewrite [text] with the skill. Never throws for a bad result: a paid-for digest is worth
     * more than a failed edit of it, so refusals, truncations and errors return the original.
     */
    suspend fun humanizeText(
        config: LlmConfig,
        skill: HumanizerSkill,
        text: String,
        forSpeech: Boolean = false,
        temperature: Double? = null,
        minLengthRatio: Double = 0.6,
        baseDelayMs: Long = 2000,
        onWarning: (String) -> Unit = {},
    ): String {
        val raw = try {
            chatCompletionWithRetry(config, buildMessages(skill, text, forSpeech), false, 3, baseDelayMs, temperature ?: skill.temperature)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onWarning("humanizer pass failed (${e.message}) — keeping the original")
            return text
        }
        val humanized = unwrap(raw)
        if (humanized.isEmpty()) {
            onWarning("humanizer returned nothing — keeping the original")
            return text
        }
        if (humanized.length < text.length * minLengthRatio) {
            onWarning(
                "humanizer returned ${humanized.length} chars against ${text.length} " +
                    "(below the ${Js.number(minLengthRatio)} floor, likely truncated) — keeping the original",
            )
            return text
        }
        return humanized
    }
}
