package today.cypherpunk.nalgorithm.hosted

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "Play sample": a short fixed sentence in the chosen voice, made once per voice on the
 * server; no digest is written. The sample needs the session, so it plays through
 * ExoPlayer with the auth headers. Main thread only.
 */
class VoiceSamplePlayer(private val context: Context, private val headers: () -> Map<String, String>) {
    private var player: ExoPlayer? = null
    private val _status = MutableStateFlow(HostedController.Status())
    val status: StateFlow<HostedController.Status> = _status.asStateFlow()

    fun setStatus(status: HostedController.Status) {
        _status.value = status
    }

    @OptIn(UnstableApi::class)
    fun play(url: String) {
        stop()
        val http = DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers())
        val p = ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build()
        player = p
        _status.value = HostedController.Status("Loading the sample…")
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying && player === p) _status.value = HostedController.Status("Playing a short sample.")
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && player === p) {
                    _status.value = HostedController.Status()
                    release(p)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (player !== p) return
                _status.value = HostedController.Status("The sample could not play right now. The voice still works for digests.", true)
                release(p)
            }
        })
        p.setMediaItem(MediaItem.fromUri(url))
        p.prepare()
        p.play()
    }

    private fun release(p: ExoPlayer) {
        if (player === p) player = null
        p.release()
    }

    fun stop() {
        player?.let(::release)
    }
}
