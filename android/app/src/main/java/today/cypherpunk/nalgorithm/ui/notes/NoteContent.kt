package today.cypherpunk.nalgorithm.ui.notes

import today.cypherpunk.nalgorithm.model.MediaMeta
import today.cypherpunk.nalgorithm.model.NostrEvent
import java.net.URI
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// ─── Media (render.ts, lib/src/media.ts) ─────────────────────────────────────

data class MediaItem(
    val video: Boolean,
    val url: String,
    val width: Int? = null,
    val height: Int? = null,
    /** The author's description; never invented here. */
    val alt: String? = null,
)

object NoteMedia {
    private const val MAX_MEDIA = 8
    private const val MAX_ALT = 500
    private val IMAGE = Regex("\\.(jpg|jpeg|png|gif|webp|svg|avif)(\\?.*)?$", RegexOption.IGNORE_CASE)
    private val VIDEO = Regex("\\.(mp4|webm|mov|ogg)(\\?.*)?$", RegexOption.IGNORE_CASE)
    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)
    private val DIM = Regex("^(\\d{1,5})x(\\d{1,5})$")
    private val MIME = Regex("^[a-z]+/[a-z0-9.+-]+$", RegexOption.IGNORE_CASE)
    private val URLS = Regex("https?://\\S+")
    private val TRAILING = Regex("[)>]+$")

    fun isVideoUrl(url: String): Boolean = VIDEO.containsMatchIn(url)
    fun isImageUrl(url: String): Boolean = IMAGE.containsMatchIn(url) || ("nostr.build" in url && !isVideoUrl(url))
    fun isMediaUrl(url: String): Boolean = isImageUrl(url) || isVideoUrl(url)

    /** Safe, bounded media metadata from a note's NIP-92 `imeta` tags. Only http(s) addresses are kept. */
    fun readImeta(tags: List<List<String>>?): List<MediaMeta> {
        val out = ArrayList<MediaMeta>()
        for (tag in tags.orEmpty()) {
            if (tag.firstOrNull() != "imeta" || out.size >= MAX_MEDIA) continue
            var url: String? = null
            var w: Int? = null
            var h: Int? = null
            var alt: String? = null
            var mime: String? = null
            for (entry in tag.drop(1)) {
                val space = entry.indexOf(' ')
                if (space < 1) continue
                val name = entry.substring(0, space)
                val value = entry.substring(space + 1).trim()
                when (name) {
                    "url" -> if (HTTP.containsMatchIn(value)) url = value
                    "dim" -> DIM.matchEntire(value)?.let { m ->
                        val a = m.groupValues[1].toInt()
                        val b = m.groupValues[2].toInt()
                        if (a > 0 && b > 0) { w = a; h = b }
                    }
                    "alt" -> if (value.isNotEmpty()) alt = value.take(MAX_ALT)
                    "m" -> if (MIME.matches(value)) mime = value.lowercase()
                }
            }
            val u = url ?: continue
            if (out.none { it.url == u }) out += MediaMeta(u, w, h, alt, mime)
        }
        return out
    }

    /** Media items from the note's imeta summary and the media URLs in its text. */
    fun extract(content: String, meta: List<MediaMeta>): List<MediaItem> {
        val items = ArrayList<MediaItem>()
        val seen = HashSet<String>()
        val known = meta.associateBy { it.url }
        fun add(url: String) {
            if (!seen.add(url)) return
            val m = known[url]
            val video = m?.mime?.startsWith("video/") ?: isVideoUrl(url)
            items += MediaItem(video, url, m?.width, m?.height, m?.alt)
        }
        meta.forEach { add(it.url) }
        for (match in URLS.findAll(content)) {
            val clean = match.value.replace(TRAILING, "")
            if (isMediaUrl(clean)) add(clean)
        }
        return items
    }

    fun hostOf(url: String): String = runCatching { URI(url).host.orEmpty() }.getOrDefault("")
}

// ─── Link previews (hosted/previews-logic.ts) ────────────────────────────────

object LinkPreviews {
    const val MAX_CARDS_PER_POST = 2
    private val URLS = Regex("https?://[^\\s<>\"]+", RegexOption.IGNORE_CASE)
    private val TRAILING = Regex("[)\\]>.,;:!?'\"]+$")
    private val MEDIA_EXT = Regex("\\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|webm|mov|ogg|mp3|wav|flac|m4a|aac|opus)$", RegexOption.IGNORE_CASE)

    /** The first http(s) URLs of [content] that deserve a card: not media, not the app's own host, each page once. */
    fun extractPreviewUrls(content: String, ownHost: String = "", max: Int = MAX_CARDS_PER_POST): List<String> {
        val out = ArrayList<String>()
        val seen = HashSet<String>()
        for (m in URLS.findAll(content)) {
            val uri = runCatching { URI(m.value.replace(TRAILING, "")) }.getOrNull() ?: continue
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") continue
            if (uri.rawUserInfo != null) continue
            val host = uri.host ?: continue
            val path = uri.path.orEmpty()
            if (MEDIA_EXT.containsMatchIn(path) || host == "nostr.build" || host.endsWith(".nostr.build")) continue
            if (ownHost.isNotEmpty() && uri.rawAuthority == ownHost) continue
            val key = rebuild(uri)
            if (!seen.add(key)) continue
            out += key
            if (out.size >= max) break
        }
        return out
    }

    /** The URL without its fragment, the path at least "/" (as `new URL()` serialises it). */
    private fun rebuild(uri: URI): String = buildString {
        append(uri.scheme.lowercase()).append("://").append(uri.rawAuthority)
        append(uri.rawPath.ifEmpty { "/" })
        uri.rawQuery?.let { append('?').append(it) }
    }
}

// ─── Threads (note-logic.ts, NIP-10) ─────────────────────────────────────────

object Thread {
    data class Ref(val id: String, val relay: String?, val author: String?)

    /** The direct parent of an event per NIP-10 (marked or positional), or null for a top-level note. */
    fun parentOf(event: NostrEvent): Ref? {
        val eTags = event.tags.filter { it.size >= 2 && it[0] == "e" }
        if (eTags.isEmpty()) return null
        val marked = eTags.filter { it.size >= 4 && (it[3] == "root" || it[3] == "reply") }
        val tag = if (marked.isNotEmpty()) {
            marked.firstOrNull { it[3] == "reply" } ?: marked.first { it[3] == "root" }
        } else {
            // Deprecated positional form: the last `e` is the one replied to, the first the root.
            eTags.filterNot { it.size >= 4 && it[3] == "mention" }.lastOrNull() ?: return null
        }
        val id = tag[1]
        if (!NoteIds.isHex64(id)) return null
        val author = tag.getOrNull(4)?.takeIf { NoteIds.isHex64(it) }
        return Ref(id, tag.getOrNull(2)?.takeIf { it.isNotBlank() }, author)
    }

    /** Direct replies to [targetId], oldest first, at most [limit]. Events that only mention it are dropped. */
    fun directReplies(events: List<NostrEvent>, targetId: String, limit: Int = 20): List<NostrEvent> {
        val seen = HashSet<String>()
        val out = ArrayList<NostrEvent>()
        for (e in events) {
            if (e.kind != 1 || !seen.add(e.id)) continue
            if (parentOf(e)?.id == targetId) out += e
        }
        out.sortWith(compareBy<NostrEvent> { it.createdAt }.thenBy { it.id })
        return out.take(limit)
    }
}

// ─── Time (time.ts) ──────────────────────────────────────────────────────────

object NoteTime {
    /** The locale's own order for these fields; the plain pattern where Android has none to give (JVM tests). */
    private fun pattern(locale: Locale, skeleton: String, fallback: String): String =
        runCatching { android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton) }.getOrNull() ?: fallback

    /** Note age as a client shows it: "now", "5m", "2h", "3d", then a date. */
    fun relative(unixSeconds: Long, nowMs: Long = System.currentTimeMillis(), locale: Locale = Locale.getDefault()): String {
        val diff = maxOf(0L, nowMs - unixSeconds * 1000)
        val min = diff / 60_000
        if (min < 1) return "now"
        if (min < 60) return "${min}m"
        val h = min / 60
        if (h < 24) return "${h}h"
        val d = h / 24
        if (d < 7) return "${d}d"
        return SimpleDateFormat(pattern(locale, "MMMd", "MMM d"), locale).format(Date(unixSeconds * 1000))
    }

    /** "Tue 30 Sep" in the viewer's locale; "Today" / "Yesterday" for the last two days. */
    fun dayLabel(unixSeconds: Long, nowMs: Long = System.currentTimeMillis(), locale: Locale = Locale.getDefault()): String {
        fun startOf(ms: Long): Long = Calendar.getInstance().apply {
            timeInMillis = ms
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        val days = Math.round((startOf(nowMs) - startOf(unixSeconds * 1000)) / 86_400_000.0)
        if (days == 0L) return "Today"
        if (days == 1L) return "Yesterday"
        return SimpleDateFormat(pattern(locale, "EEEdMMM", "EEE d MMM"), locale).format(Date(unixSeconds * 1000))
    }

    fun clockLabel(unixSeconds: Long, locale: Locale = Locale.getDefault()): String =
        DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(Date(unixSeconds * 1000))

    /** The full date and time, for the accessible label of a relative time. */
    fun full(unixSeconds: Long, locale: Locale = Locale.getDefault()): String =
        DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale).format(Date(unixSeconds * 1000))
}
