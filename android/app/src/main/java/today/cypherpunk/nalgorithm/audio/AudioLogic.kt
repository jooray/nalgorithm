package today.cypherpunk.nalgorithm.audio

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Player logic: speed, resume position, waveform, seeking (web/src/audio-logic.ts).
 * Pure (storage is passed in), so it runs under plain JUnit.
 */

/** The little storage the player needs; SharedPreferences in the app, a map in tests. */
interface KeyValueStore {
    fun getItem(key: String): String?
    fun setItem(key: String, value: String)
    fun removeItem(key: String)
}

// ─── Speed ───────────────────────────────────────────────────────────────────

val SPEEDS = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)
const val DEFAULT_SPEED = 1f

/** A known speed, or the default for anything else. */
fun normalizeSpeed(value: Float?): Float = if (value != null && value in SPEEDS) value else DEFAULT_SPEED

/** "1.25×", "1×", "0.75×". */
fun formatSpeed(speed: Float): String {
    val text = if (speed == floor(speed)) speed.toInt().toString() else speed.toString()
    return "$text×"
}

/** The speed after [current] in the list, wrapping round. */
fun nextSpeed(current: Float): Float {
    val i = SPEEDS.indexOf(current)
    if (i < 0) return DEFAULT_SPEED
    return SPEEDS[(i + 1) % SPEEDS.size]
}

// ─── Resume position and played marks ────────────────────────────────────────

data class ResumeEntry(val pos: Double, val dur: Double, val at: Long, val played: Boolean = false)

private const val RESUME_KEY = "nalgorithm_resume_v1"
private const val RESUME_MAX_ENTRIES = 100

/** Below this there is nothing worth resuming. */
const val MIN_RESUME_SECONDS = 3.0

/** This close to the end counts as finished. */
const val END_SLACK_SECONDS = 10.0

/** Whether the position is so near the end that the next play should start over. */
fun isNearEnd(pos: Double, dur: Double): Boolean = dur > 0 && (dur - pos <= END_SLACK_SECONDS || pos / dur >= 0.97)

/** "Resume at 1:23", or null when there is nothing to resume. */
fun resumeHint(pos: Double?): String? {
    if (pos == null || pos < MIN_RESUME_SECONDS) return null
    return "Resume at ${formatClock(pos)}"
}

/** Resume marks per digest, at most a hundred, oldest dropped first. */
class ResumeStore(private val store: KeyValueStore?) {
    private var cache: MutableMap<String, ResumeEntry>? = null

    private fun read(): MutableMap<String, ResumeEntry> {
        cache?.let { return it }
        val out = LinkedHashMap<String, ResumeEntry>()
        try {
            val raw = store?.getItem(RESUME_KEY)
            val data = raw?.let { Json.parseToJsonElement(it) } as? JsonObject
            if (data != null) {
                for ((k, v) in data) {
                    val e = v as? JsonObject ?: continue
                    val pos = (e["pos"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: continue
                    if (!pos.isFinite()) continue
                    val dur = (e["dur"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() } ?: 0.0
                    val at = (e["at"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toLong() ?: 0L
                    val played = (e["played"] as? JsonPrimitive)?.booleanOrNull == true
                    out[k] = ResumeEntry(max(0.0, pos), max(0.0, dur), at, played)
                }
            }
        } catch (_: Exception) {
            // Garbage reads as empty.
        }
        cache = out
        return out
    }

    private fun write(all: MutableMap<String, ResumeEntry>) {
        if (all.size > RESUME_MAX_ENTRIES) {
            val drop = all.entries.sortedByDescending { it.value.at }.drop(RESUME_MAX_ENTRIES).map { it.key }
            for (k in drop) all.remove(k)
        }
        cache = all
        try {
            val json = buildJsonObject {
                for ((k, e) in all) {
                    put(k, buildJsonObject {
                        put("pos", e.pos)
                        put("dur", e.dur)
                        put("at", e.at)
                        if (e.played) put("played", true)
                    })
                }
            }
            store?.setItem(RESUME_KEY, json.toString())
        } catch (_: Exception) {
            // not remembered
        }
    }

    /** Another writer changed the stored marks. */
    fun invalidate() { cache = null }

    fun get(key: String): ResumeEntry? = read()[key]

    /** The position to resume from, or 0 (nothing saved, too early, or finished). */
    fun resumeAt(key: String): Double {
        val e = get(key) ?: return 0.0
        if (e.pos < MIN_RESUME_SECONDS || isNearEnd(e.pos, e.dur)) return 0.0
        return e.pos
    }

    fun isPlayed(key: String): Boolean = get(key)?.played == true

    /** Known duration for a digest, 0 when never loaded. */
    fun durationOf(key: String): Double = get(key)?.dur ?: 0.0

    /** Save the position. Near the end it is cleared instead (and marked played), so the next play starts from the top. */
    fun save(key: String, pos: Double, dur: Double, now: Long = System.currentTimeMillis()) {
        val all = read()
        val prev = all[key]
        val keepPlayed = prev?.played == true
        all[key] = when {
            isNearEnd(pos, dur) -> ResumeEntry(0.0, dur, now, true)
            pos < MIN_RESUME_SECONDS -> ResumeEntry(0.0, dur.takeIf { it > 0 } ?: prev?.dur ?: 0.0, now, keepPlayed)
            else -> ResumeEntry(pos, dur.takeIf { it > 0 } ?: prev?.dur ?: 0.0, now, keepPlayed)
        }
        write(all)
    }

    /** Record only the duration (metadata loaded) without touching the position. */
    fun saveDuration(key: String, dur: Double, now: Long = System.currentTimeMillis()) {
        if (!(dur > 0)) return
        val all = read()
        val prev = all[key]
        all[key] = ResumeEntry(prev?.pos ?: 0.0, dur, prev?.at ?: now, prev?.played == true)
        write(all)
    }

    fun markPlayed(key: String, dur: Double = 0.0, now: Long = System.currentTimeMillis()) {
        val all = read()
        all[key] = ResumeEntry(0.0, dur.takeIf { it > 0 } ?: all[key]?.dur ?: 0.0, now, true)
        write(all)
    }
}

// ─── Clock, waveform, seeking ────────────────────────────────────────────────

/** "m:ss", or "h:mm:ss" from an hour up. */
fun formatClock(seconds: Double): String {
    val s = max(0L, floor(if (seconds.isFinite()) seconds else 0.0).toLong())
    val h = s / 3600
    val m = (s % 3600) / 60
    val r = (s % 60).toString().padStart(2, '0')
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$r" else "$m:$r"
}

/**
 * A fixed pseudo-random bar pattern (heights 0.12 to 1), the same on every
 * load: it is a picture of a voice, not a measurement of this file. Same
 * generator as the web, so both draw the same shape.
 */
fun waveformBars(count: Int, seed: Int = 0x6b3df5): List<Double> {
    var a = seed
    fun rand(): Double {
        a += 0x6d2b79f5
        var t = a
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL) / 4294967296.0
    }
    val bars = ArrayList<Double>(count)
    var envelope = 0.5
    repeat(count) {
        // A slow drifting envelope with fast jitter reads as speech.
        envelope = min(1.0, max(0.25, envelope + (rand() - 0.5) * 0.35))
        val h = envelope * (0.55 + rand() * 0.45)
        bars.add(min(1.0, max(0.12, h)))
    }
    return bars
}

/** Position in 0..1 for a pointer at [x] over an element at [left] with [width]. */
fun fractionFromPointer(x: Float, left: Float, width: Float): Float {
    if (!(width > 0)) return 0f
    return min(1f, max(0f, (x - left) / width))
}

/** Move a position by [delta] seconds inside 0..duration. */
fun clampSeek(pos: Double, delta: Double, duration: Double): Double {
    val target = pos + delta
    return min(if (duration > 0) duration else Double.POSITIVE_INFINITY, max(0.0, target))
}
