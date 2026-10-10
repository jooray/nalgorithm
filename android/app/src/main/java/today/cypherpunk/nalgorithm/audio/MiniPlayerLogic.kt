package today.cypherpunk.nalgorithm.audio

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * What the mini player on the Feed tab shows (web/src/mini-player-logic.ts), and
 * what the make buttons say (digest-job-logic.ts). Pure.
 *
 * The mini player is not an audio player. It shows the latest digest (or the one
 * being written) and sends the reader to the Digests tab, where the one real player lives.
 */

data class MiniLatest(
    /** "Today, 07:30", already formatted for the reader. */
    val whenText: String,
    /** The same length label the hero and the list show, "about" rule included. */
    val length: String,
    /** This digest is the one in the main player and it is playing or loading. */
    val playing: Boolean,
    /** Where playback is now (playing) or would resume from (not playing); 0 for none. */
    val pos: Double,
    val dur: Double,
    /** "Resume at 1:23", or null when there is nothing to resume. */
    val resumeHint: String?,
)

sealed interface MiniView {
    data object None : MiniView
    data class Running(val title: String) : MiniView
    data class Ready(
        val title: String,
        val meta: String,
        val hint: String?,
        /** 0 to 1, or null when there is neither playback nor a resume position. */
        val progress: Double?,
        val playing: Boolean,
        val buttonLabel: String,
        val openLabel: String,
    ) : MiniView
}

fun miniClock(seconds: Double): String {
    val s = max(0L, floor(if (seconds.isFinite()) seconds else 0.0).toLong())
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

fun miniView(running: Boolean, elapsedSeconds: Double, latest: MiniLatest?): MiniView {
    // A digest that is playing keeps its controls even while the next one is written.
    if (running && latest?.playing != true) return MiniView.Running("Writing your digest… ${miniClock(elapsedSeconds)}")
    val l = latest ?: return MiniView.None
    val progress = if (l.dur > 0 && (l.playing || l.pos > 0)) min(1.0, max(0.0, l.pos / l.dur)) else null
    return MiniView.Ready(
        title = "Your morning",
        meta = "${l.whenText} · ${l.length}",
        hint = if (l.playing) null else l.resumeHint,
        progress = progress,
        playing = l.playing,
        buttonLabel = if (l.playing) "Pause your morning digest" else "Play your morning digest from ${l.whenText}",
        openLabel = "Open your digests",
    )
}

data class MakeButtonView(val label: String, val disabled: Boolean, val busy: Boolean)

/** What every make button says and whether it can be pressed. */
fun makeButtonView(running: Boolean, hasDigests: Boolean, firstLabel: String, anotherLabel: String): MakeButtonView =
    if (running) MakeButtonView("Writing your digest…", disabled = true, busy = true)
    else MakeButtonView(if (hasDigests) anotherLabel else firstLabel, disabled = false, busy = false)

const val ANOTHER_DIGEST_HINT = "Writes a new one from your latest notes."
