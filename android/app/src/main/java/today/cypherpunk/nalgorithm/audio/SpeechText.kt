package today.cypherpunk.nalgorithm.audio

/**
 * Splitting a digest into speakable chunks on sentence boundaries (web/src/speech.ts).
 *
 * The phone's engine has a hard input limit (TextToSpeech.getMaxSpeechInputLength), and
 * progress and seeking in Read aloud move chunk by chunk, so chunks stay short.
 */

/** Chunk target: short enough for fine progress, long enough to keep prosody. */
const val MAX_CHUNK_CHARS = 200

private val SENTENCE = Regex("""[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$""")
private val AFTER_COMMA = Regex("""(?<=,)\s+""")
private val SPACES = Regex("""\s+""")

fun splitForSpeech(text: String, maxChars: Int = MAX_CHUNK_CHARS): List<String> {
    val chunks = ArrayList<String>()
    for (paragraph in text.split(Regex("\n{2,}"))) {
        val trimmed = paragraph.trim()
        if (trimmed.isEmpty()) continue

        // Keep the terminator attached so the engine hears the sentence end.
        val sentences = SENTENCE.findAll(trimmed).map { it.value }.toList().ifEmpty { listOf(trimmed) }
        var current = ""

        for (sentence in sentences) {
            val piece = sentence.trim()
            if (piece.isEmpty()) continue

            if (piece.length > maxChars) {
                if (current.isNotEmpty()) {
                    chunks.add(current)
                    current = ""
                }
                // Overlong sentence: break on commas, then on words.
                var buffer = ""
                for (part in piece.split(AFTER_COMMA)) {
                    if ("$buffer $part".trim().length <= maxChars) {
                        buffer = if (buffer.isNotEmpty()) "$buffer $part" else part
                    } else {
                        if (buffer.isNotEmpty()) chunks.add(buffer)
                        if (part.length <= maxChars) {
                            buffer = part
                        } else {
                            buffer = ""
                            for (w in part.split(SPACES)) {
                                if ("$buffer $w".trim().length <= maxChars) {
                                    buffer = if (buffer.isNotEmpty()) "$buffer $w" else w
                                    continue
                                }
                                if (buffer.isNotEmpty()) {
                                    chunks.add(buffer)
                                    buffer = ""
                                }
                                if (w.length <= maxChars) {
                                    buffer = w
                                } else {
                                    // An unbreakable token (a long URL, say): cut it hard, the engine refuses over-limit input.
                                    var i = 0
                                    while (i < w.length) {
                                        chunks.add(w.substring(i, minOf(w.length, i + maxChars)))
                                        i += maxChars
                                    }
                                }
                            }
                        }
                    }
                }
                if (buffer.isNotEmpty()) chunks.add(buffer)
                continue
            }

            if ("$current $piece".trim().length <= maxChars) {
                current = if (current.isNotEmpty()) "$current $piece" else piece
            } else {
                if (current.isNotEmpty()) chunks.add(current)
                current = piece
            }
        }
        if (current.isNotEmpty()) chunks.add(current)
    }
    return chunks
}
