package today.cypherpunk.nalgorithm.audio

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import today.cypherpunk.nalgorithm.mode.AudioSource
import kotlin.coroutines.resume
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** What the player plays: one digest, by audio or by the phone reading its text. */
data class PlayerSource(
    /** Stable key for resume and played marks: the audio URL, else the digest id. */
    val key: String,
    val digestId: String,
    val title: String,
    /** Shown as album / subtitle: the date. */
    val subtitle: String,
    val audio: AudioSource?,
    val text: String,
    /** Exact length of the audio from the server, so the first render needs no guess. */
    val durationSeconds: Double? = null,
)

enum class PlayerMode { Audio, Speech, None }

data class PlayerState(
    val source: PlayerSource? = null,
    val mode: PlayerMode = PlayerMode.None,
    val playing: Boolean = false,
    /** Seconds. */
    val pos: Double = 0.0,
    /** Seconds; an estimate when [durApprox]. */
    val dur: Double = 0.0,
    val durApprox: Boolean = true,
    val speed: Float = DEFAULT_SPEED,
    /** Audio is being fetched (connecting, buffering, after a seek). */
    val loading: Boolean = false,
    val error: String = "",
    /** Where playback would resume from (0 when nothing to resume). */
    val resumeAt: Double = 0.0,
    val played: Boolean = false,
    /** Read aloud: chunk being spoken (1-based) and the total, for the progress line. */
    val speechChunk: Int = 0,
    val speechChunks: Int = 0,
)

/**
 * The one digest player (web/src/player.ts). Two sources behind one interface:
 *
 *  - audio: through [PlaybackService] and a MediaController, so it keeps playing in the
 *    background with notification, lock-screen and headset controls;
 *  - speech: the phone's speech engine reading the text. Position is tracked per spoken
 *    chunk and a seek restarts from the chunk that contains the target. Its duration is
 *    an estimate from the word count.
 *
 * Nothing ever plays by itself: [play] is only called from a press or a media key.
 * Loading a source does not touch the service, so no audio is fetched and no
 * notification appears until play is pressed.
 */
class DigestPlayer(
    context: Context,
    private val scope: CoroutineScope,
    private val resume: ResumeStore,
    private val loadSpeed: () -> Float,
    private val saveSpeed: (Float) -> Unit,
    private val voiceName: () -> String,
) {
    private val context = context.applicationContext
    private val _state = MutableStateFlow(blank())
    val state: StateFlow<PlayerState> = _state.asStateFlow()
    val current: PlayerState get() = _state.value

    private val speech = SpeechEngine(this.context).also { it.onInterrupted = { if (current.mode == PlayerMode.Speech && current.playing) pause() } }
    private var speechChunks: List<String> = emptyList()
    private var speechStart = 0

    private var controller: MediaController? = null
    private var connecting: Job? = null
    /** The source key whose item is in the service right now (null: none set yet). */
    private var itemKey: String? = null
    private var ticker: Job? = null
    private var saver: Job? = null
    private var listenerAttached: MediaController? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = syncFromController()
        override fun onPlayerError(error: PlaybackException) {
            if (!ours()) return
            set { it.copy(playing = false, loading = false, error = "This audio could not be loaded. Check your connection, then press play to try again.") }
        }
    }

    // ─── public ──────────────────────────────────────────────────────────────

    /** Select a digest. Stops whatever was playing; never starts playback. */
    fun load(source: PlayerSource?) {
        val s = current
        if (s.source?.key == source?.key && s.source?.audio == source?.audio) {
            // Same digest: only the text may have changed (streaming finished).
            if (source != null) _state.value = s.copy(source = source)
            return
        }
        persist()
        stopOutput()
        if (source == null) {
            _state.value = blank()
            return
        }
        val speed = loadSpeed()
        val resumeAt = resume.resumeAt(source.key)
        val knownDur = resume.durationOf(source.key)
        val usesAudio = source.audio != null
        val serverDur = if (usesAudio) source.durationSeconds?.takeIf { it > 0 } ?: 0.0 else 0.0
        val speechOk = source.text.isNotBlank()
        speechChunks = if (!usesAudio && speechOk) splitForSpeech(source.text, speech.maxChunkChars()) else emptyList()
        _state.value = PlayerState(
            source = source,
            mode = if (usesAudio) PlayerMode.Audio else if (speechOk) PlayerMode.Speech else PlayerMode.None,
            playing = false,
            pos = resumeAt,
            dur = serverDur.takeIf { it > 0 } ?: knownDur.takeIf { it > 0 } ?: estimateSeconds(source.text),
            durApprox = knownDur <= 0 && serverDur <= 0,
            speed = speed,
            loading = false,
            error = if (usesAudio || speechOk) "" else "This digest has no audio, and there is no text to read aloud.",
            resumeAt = resumeAt,
            played = resume.isPlayed(source.key),
            speechChunks = speechChunks.size,
        )
    }

    fun play() {
        val s = current
        val source = s.source ?: return
        if (s.mode == PlayerMode.None) return
        if (s.mode == PlayerMode.Audio) {
            set { it.copy(loading = true, error = "") }
            withController { c -> startAudio(c, source) }
        } else {
            startSpeech(if (s.pos >= s.dur - 1) 0.0 else s.pos)
        }
        startSaving()
    }

    fun pause() {
        if (current.mode == PlayerMode.Audio) {
            controller?.takeIf { ours() }?.pause()
            set { it.copy(playing = false, loading = false) }
            persist()
        } else {
            speech.stop()
            set { it.copy(playing = false) }
            persist()
        }
        stopSaving()
    }

    fun toggle() {
        if (current.playing || current.loading) pause() else play()
    }

    fun seek(seconds: Double) {
        val s = current
        if (s.source == null || s.mode == PlayerMode.None) return
        val target = min(max(0.0, seconds), if (s.dur > 0) s.dur else max(0.0, seconds))
        if (s.mode == PlayerMode.Audio) {
            controller?.takeIf { ours() }?.seekTo((target * 1000).toLong())
            set { it.copy(pos = target) }
        } else {
            set { it.copy(pos = target) }
            if (s.playing) startSpeech(target)
        }
        persist()
    }

    fun skip(delta: Double) = seek(clampSeek(current.pos, delta, current.dur))

    fun setSpeed(speed: Float) {
        val v = normalizeSpeed(speed)
        saveSpeed(v)
        controller?.takeIf { ours() }?.setPlaybackParameters(PlaybackParameters(v))
        set { it.copy(speed = v) }
        // The speech engine takes a rate per utterance: restart this chunk at the new one.
        if (current.mode == PlayerMode.Speech && current.playing) startSpeech(current.pos)
    }

    /** Write the position now (the app goes to the background). */
    fun checkpoint() = persist()

    // ─── audio through the service ───────────────────────────────────────────

    private fun ours(): Boolean = controller != null && itemKey != null && itemKey == current.source?.key

    private fun withController(block: (MediaController) -> Unit) {
        controller?.takeIf { it.isConnected }?.let { block(it); return }
        if (connecting?.isActive == true) {
            // A press while connecting: the connection's continuation uses the latest state.
            return
        }
        connecting = scope.launch {
            val c = connect()
            if (c == null) {
                set { it.copy(playing = false, loading = false, error = "Playback could not start. Press play to try again.") }
                return@launch
            }
            // Still wanting to play this source? (The reader may have paused or moved on.)
            val src = current.source
            if (src != null && current.mode == PlayerMode.Audio && current.loading) block(c)
        }
    }

    private suspend fun connect(): MediaController? {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token)
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    if (this@DigestPlayer.controller === controller) {
                        this@DigestPlayer.controller = null
                        itemKey = null
                        set { it.copy(playing = false, loading = false) }
                        persist()
                    }
                }
            })
            .buildAsync()
        val c = suspendCancellableCoroutine<MediaController?> { cont ->
            future.addListener({
                cont.resume(runCatching { future.get() }.getOrNull())
            }, ContextCompat.getMainExecutor(context))
            cont.invokeOnCancellation { future.cancel(true) }
        } ?: return null
        controller = c
        if (listenerAttached !== c) {
            c.addListener(listener)
            listenerAttached = c
        }
        return c
    }

    private fun startAudio(c: MediaController, source: PlayerSource) {
        val audio = source.audio ?: return
        val s = current
        if (itemKey != source.key || c.mediaItemCount == 0 || c.playbackState == Player.STATE_IDLE) {
            val uri = when (audio) {
                is AudioSource.Remote -> Uri.parse(audio.url)
                is AudioSource.Local -> Uri.fromFile(audio.file)
            }
            val headers = Bundle().apply { (audio as? AudioSource.Remote)?.headers?.forEach { (k, v) -> putString(k, v) } }
            val item = MediaItem.Builder()
                .setMediaId(source.key)
                .setUri(uri)
                .setRequestMetadata(
                    MediaItem.RequestMetadata.Builder()
                        .setMediaUri(uri)
                        .setExtras(Bundle().apply { putBundle(PlaybackService.EXTRA_HEADERS, headers) })
                        .build(),
                )
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(source.title)
                        .setArtist("nalgorithm")
                        .setAlbumTitle(source.subtitle)
                        .setDisplayTitle(source.title)
                        .setSubtitle(source.subtitle)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
                        .build(),
                )
                .build()
            itemKey = source.key
            val startMs = if (s.pos >= s.dur - 1 && s.dur > 0) 0L else (s.pos * 1000).toLong()
            c.setMediaItem(item, startMs)
            c.prepare()
        } else if (c.playbackState == Player.STATE_ENDED) {
            c.seekTo(0)
        }
        c.setPlaybackParameters(PlaybackParameters(s.speed))
        c.play()
        startTicker()
    }

    /** Mirror the service's player into our state, while it is playing our source. */
    private fun syncFromController() {
        val c = controller ?: return
        if (!ours()) return
        val s = current
        val durMs = c.duration
        var dur = s.dur
        var durApprox = s.durApprox
        val hasServerLength = s.source?.durationSeconds?.let { it > 0 } == true
        if (durMs != C.TIME_UNSET && durMs > 0) {
            val d = durMs / 1000.0
            s.source?.let { resume.saveDuration(it.key, d) }
            // The server measured this digest frame by frame; the player's first figure may be a bitrate guess.
            if (!hasServerLength) { dur = d; durApprox = false }
        }
        val pos = c.currentPosition / 1000.0
        // Never let the position run past the length we are showing.
        if (dur > 0 && pos > dur) dur = pos
        val buffering = c.playbackState == Player.STATE_BUFFERING && c.playWhenReady
        val playing = c.isPlaying
        if (c.playbackState == Player.STATE_ENDED && s.source != null && (s.playing || s.loading)) {
            finish(if (durMs != C.TIME_UNSET && durMs > 0) durMs / 1000.0 else null)
            return
        }
        val wasPlaying = s.playing || s.loading
        _state.value = s.copy(
            playing = playing,
            loading = buffering,
            pos = if (c.playbackState == Player.STATE_IDLE) s.pos else pos,
            dur = dur,
            durApprox = durApprox,
            speed = c.playbackParameters.speed.takeIf { it in SPEEDS } ?: s.speed,
            error = if (playing) "" else s.error,
        )
        if (wasPlaying && !playing && !buffering) {
            // Paused from the notification, a headset or another app taking the audio.
            persist()
            stopSaving()
        } else if (playing && saver?.isActive != true) {
            startSaving()
            startTicker()
        }
    }

    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(250)
                val st = current
                if (!(st.playing || st.loading) || st.mode != PlayerMode.Audio) break
                syncFromController()
            }
        }
    }

    // ─── speech ──────────────────────────────────────────────────────────────

    private fun startSpeech(fromSeconds: Double) {
        val s = current
        if (s.source == null) return
        speech.stop()
        val total = speechChunks.size
        if (total == 0) return
        val fraction = if (s.dur > 0) min(0.999, max(0.0, fromSeconds / s.dur)) else 0.0
        val start = floor(fraction * total).toInt()
        speechStart = start
        set { it.copy(playing = true, error = "", pos = (start.toDouble() / total) * s.dur, speechChunk = start + 1) }
        val key = s.source.key
        scope.launch {
            speech.speak(
                chunks = speechChunks,
                start = start,
                rate = s.speed,
                voiceName = voiceName(),
                onProgress = { index ->
                    if (current.source?.key != key) return@speak
                    val i = min(total - 1, index)
                    set { it.copy(pos = (i.toDouble() / total) * it.dur, speechChunk = i + 1) }
                },
                onEnd = { if (current.source?.key == key) finish(null) },
                onError = { message -> if (current.source?.key == key) set { it.copy(playing = false, error = message) } },
            )
        }
    }

    // ─── bookkeeping ─────────────────────────────────────────────────────────

    private fun finish(trueDur: Double?) {
        val s = current
        val key = s.source?.key
        // The true length is known once the audio has played to its end.
        val dur = if (s.mode == PlayerMode.Audio && trueDur != null && trueDur > 0 && s.source?.durationSeconds == null) trueDur else s.dur
        if (key != null) resume.markPlayed(key, dur)
        stopSaving()
        _state.value = s.copy(dur = dur, playing = false, loading = false, pos = 0.0, resumeAt = 0.0, played = true, speechChunk = 0)
        if (s.mode == PlayerMode.Audio) controller?.takeIf { ours() }?.let {
            it.playWhenReady = false
            it.seekTo(0)
        }
    }

    private fun stopOutput() {
        stopSaving()
        speech.stop()
        ticker?.cancel()
        controller?.let {
            if (itemKey != null) {
                it.stop()
                it.clearMediaItems()
            }
        }
        itemKey = null
    }

    /** Write the position to the resume store (clears it near the end). */
    private fun persist() {
        val s = current
        val source = s.source ?: return
        if (s.mode == PlayerMode.None) return
        resume.save(source.key, s.pos, if (s.durApprox) 0.0 else s.dur)
        _state.value = current.copy(resumeAt = resume.resumeAt(source.key), played = resume.isPlayed(source.key))
    }

    private fun startSaving() {
        stopSaving()
        saver = scope.launch {
            while (isActive) {
                delay(5000)
                persist()
            }
        }
    }

    private fun stopSaving() {
        saver?.cancel()
        saver = null
    }

    private fun blank() = PlayerState(speed = runCatching { loadSpeed() }.getOrDefault(DEFAULT_SPEED))

    private inline fun set(change: (PlayerState) -> PlayerState) {
        _state.value = change(_state.value)
        val s = _state.value
        if (!s.playing && !s.loading) stopSaving()
    }

    /** Leave the app's process tidy: release the speech engine and the controller. */
    fun release() {
        persist()
        stopOutput()
        speech.shutdown()
        controller?.release()
        controller = null
    }
}
