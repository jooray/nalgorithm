package today.cypherpunk.nalgorithm.audio

import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.DigestSourceNote
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ProfileSnapshot
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.floor
import kotlin.math.max

/**
 * Digest lengths, lines, keys and labels (web/src/digest-model.ts, time.ts).
 * Pure, so it is tested under plain JUnit.
 */

/** Spoken words per second at 1x, for estimating a length nobody has measured. */
private const val WORDS_PER_SECOND = 2.6

fun wordCount(text: String): Int = text.split(Regex("\\s+")).count { it.isNotEmpty() }

fun estimateSeconds(text: String): Double = Math.round(wordCount(text) / WORDS_PER_SECOND).toDouble()

/** JS Math.round: halves go up. */
private fun jsRound(x: Double): Long = floor(x + 0.5).toLong()

/** "3 min 52 s", or "about 4 min" when only an estimate exists. */
fun formatLength(seconds: Double, approx: Boolean = false): String {
    val s = max(0L, jsRound(seconds))
    if (approx) return "about ${max(1L, jsRound(s / 60.0))} min"
    val m = s / 60
    val r = s % 60
    if (m == 0L) return "$r s"
    return if (r == 0L) "$m min" else "$m min $r s"
}

/**
 * The length a digest shows, most trustworthy first: the server's exact figure, then what the
 * player measured (still "about" until played through once), then a guess from the word count.
 */
fun digestLengthLabel(knownSeconds: Double, played: Boolean, serverSeconds: Double?, text: String): String {
    if (serverSeconds != null && serverSeconds > 0) return formatLength(serverSeconds)
    if (knownSeconds > 0) return formatLength(knownSeconds, !played)
    return formatLength(estimateSeconds(text), true)
}

/** The first [n] non-empty lines of a digest, for a list entry. */
fun firstLines(text: String, n: Int = 2): String =
    text.split(Regex("\n+")).map { it.trim() }.filter { it.isNotEmpty() }.take(n).joinToString(" ")

/** Only http(s) links are ever played or fetched (hosted/logic.ts safeAudioUrl). */
fun safeAudioUrl(value: String?): String? {
    if (value == null) return null
    val lower = value.trim().lowercase(Locale.ROOT)
    return if ((lower.startsWith("https://") || lower.startsWith("http://")) && value.length > 8 && value.none { it.isWhitespace() }) value else null
}

/** Resume and played marks are keyed by the audio link, else by the digest id. */
fun digestKey(id: String, audioUrl: String?): String = if (audioUrl != null) "audio:$audioUrl" else "digest:$id"

/** Key for resume marks: a made or cached audio file still belongs to its digest. */
fun keyOf(d: DigestRecord): String = digestKey(d.id, safeAudioUrl(d.audioUrl))

/** The server's exact length, when this digest has audio to go with it. */
fun exactSeconds(d: DigestRecord): Double? =
    d.durationSeconds?.takeIf { it > 0 && safeAudioUrl(d.audioUrl) != null }

/** Newest first; ties keep their order. */
fun newestFirst(items: List<DigestRecord>): List<DigestRecord> =
    items.withIndex().sortedWith(compareByDescending<IndexedValue<DigestRecord>> { it.value.createdAt }.thenBy { it.index }).map { it.value }

/** A show note as the note card wants it: a scored post with no raw event beyond its kind. */
fun toScoredPost(note: DigestSourceNote): ScoredPost = ScoredPost(
    id = note.id,
    type = PostType.Original,
    author = note.pubkey,
    content = note.content,
    createdAt = note.createdAt,
    score = note.score,
    justification = note.reason,
    rawEvent = NostrEvent(
        id = note.id,
        pubkey = note.pubkey,
        createdAt = note.createdAt,
        kind = note.kind ?: 1,
        tags = emptyList(),
        content = note.content,
        sig = "",
    ),
)

/** Unique author pubkeys across a digest's notes, in first-seen order. */
fun notePubkeys(notes: List<DigestSourceNote>): List<String> = notes.map { it.pubkey }.distinct()

/** Profiles kept with a digest, under what this device knows now (fresher wins). */
fun notesProfiles(snapshots: Map<String, ProfileSnapshot>?, known: Map<String, ProfileData>, pubkeys: List<String>): Map<String, ProfileData> {
    val out = LinkedHashMap<String, ProfileData>()
    for (pk in pubkeys) {
        val live = known[pk]
        val snap = snapshots?.get(pk)
        when {
            live != null -> out[pk] = live
            snap != null -> out[pk] = ProfileData(pubkey = pk, name = snap.name, picture = snap.picture, nip05 = snap.nip05)
        }
    }
    return out
}

/** Paragraphs of a digest, as the text tab and the generation view show them. */
fun paragraphs(text: String): List<String> = text.split(Regex("\n{2,}")).map { it.trim() }.filter { it.isNotEmpty() }

/** `nalgorithm-YYYY-MM-DD-<id>.mp3`, the date in UTC like the web's toISOString(). */
fun mp3FileName(d: DigestRecord): String = "nalgorithm-${utcDate(d.createdAt)}-${d.id}.mp3"

/** Bring your own key, a made audio file: `nalgorithm-digest-YYYY-MM-DD.mp3`. */
fun madeAudioFileName(d: DigestRecord): String = "nalgorithm-digest-${utcDate(d.createdAt)}.mp3"

private fun utcDate(unixSeconds: Long): String = Instant.ofEpochSecond(unixSeconds).atOffset(ZoneOffset.UTC).toLocalDate().toString()

/** "Today", "Yesterday", "Mon 6 Oct"; and the clock time, both in the reader's zone and locale. */
object DigestLabels {
    /** Set from the system's 24-hour setting when the app starts. */
    @Volatile var use24Hour: Boolean = true
    /** The locale's skeleton for weekday, day and month ("EEE d MMM" in English). */
    @Volatile var dayPattern: String = "EEE d MMM"

    fun dayLabel(unixSeconds: Long, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val day = Instant.ofEpochSecond(unixSeconds).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        if (days == 0L) return "Today"
        if (days == 1L) return "Yesterday"
        return DateTimeFormatter.ofPattern(dayPattern, locale).format(day)
    }

    fun clockLabel(unixSeconds: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val time = Instant.ofEpochSecond(unixSeconds).atZone(zone)
        return DateTimeFormatter.ofPattern(if (use24Hour) "HH:mm" else "hh:mm a", locale).format(time)
    }

    /** "Today, 07:30" */
    fun whenLabel(unixSeconds: Long): String = "${dayLabel(unixSeconds)}, ${clockLabel(unixSeconds)}"
}
