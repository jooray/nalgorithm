package today.cypherpunk.nalgorithm.engine

import today.cypherpunk.nalgorithm.model.MediaMeta

/** Media attached to a note, from its NIP-92 `imeta` tags (lib media.ts). */
object Media {
    private const val MAX_MEDIA = 8
    private const val MAX_ALT = 500
    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)
    private val DIM = Regex("^(\\d{1,5})x(\\d{1,5})$")
    private val MIME = Regex("^[a-z]+/[a-z0-9.+-]+$", RegexOption.IGNORE_CASE)

    /** Safe, bounded media metadata from a note's tags. Only http(s) addresses are kept. */
    fun readImeta(tags: List<List<String>>?): List<MediaMeta> {
        val out = mutableListOf<MediaMeta>()
        for (tag in tags.orEmpty()) {
            if (tag.firstOrNull() != "imeta" || out.size >= MAX_MEDIA) continue
            var url: String? = null
            var width: Int? = null
            var height: Int? = null
            var alt: String? = null
            var mime: String? = null
            for (entry in tag.drop(1)) {
                val space = entry.indexOf(' ')
                if (space < 1) continue
                val name = entry.substring(0, space)
                val value = entry.substring(space + 1).trim()
                when {
                    name == "url" && HTTP.containsMatchIn(value) -> url = value
                    name == "dim" -> DIM.find(value)?.let { m ->
                        val w = m.groupValues[1].toInt()
                        val h = m.groupValues[2].toInt()
                        if (w > 0 && h > 0) { width = w; height = h }
                    }
                    name == "alt" && value.isNotEmpty() -> alt = value.take(MAX_ALT)
                    name == "m" && MIME.matches(value) -> mime = value.lowercase()
                }
            }
            val u = url ?: continue
            if (out.none { it.url == u }) out.add(MediaMeta(u, width, height, alt, mime))
        }
        return out
    }
}
