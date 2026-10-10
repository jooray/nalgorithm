package today.cypherpunk.nalgorithm.audio

import android.app.PendingIntent
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.common.Player
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import today.cypherpunk.nalgorithm.MainActivity
import today.cypherpunk.nalgorithm.R
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Digest playback that keeps going with the screen off or the app in the background:
 * ExoPlayer in a media session, with the notification, lock-screen and headset controls
 * that come with it. The app talks to it only through a MediaController (DigestPlayer).
 *
 * A media item crosses from the controller with its address in `requestMetadata.mediaUri`
 * and its request headers (the hosted API needs `Authorization: Bearer`) in the request
 * extras; [onAddMediaItems] turns that back into a playable item.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    companion object {
        const val EXTRA_HEADERS = "nalgorithm.headers"
        const val BACK_MS = 15_000L
        const val FORWARD_MS = 30_000L
    }

    private var session: MediaSession? = null
    private val headers = ConcurrentHashMap<String, Map<String, String>>()
    private val artwork: ByteArray? by lazy {
        runCatching {
            val bitmap = BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher_foreground)
            ByteArrayOutputStream().use { out ->
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
                out.toByteArray()
            }
        }.getOrNull()
    }

    override fun onCreate() {
        super.onCreate()
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("nalgorithm-android")
            .setAllowCrossProtocolRedirects(false)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        val upstream = DefaultDataSource.Factory(this, http)
        val withHeaders = ResolvingDataSource.Factory(upstream) { spec ->
            val extra = headers[spec.uri.toString()]
            if (extra.isNullOrEmpty()) spec else spec.withAdditionalHeaders(extra)
        }
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(withHeaders))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(BACK_MS)
            .setSeekForwardIncrementMs(FORWARD_MS)
            .build()

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(open)
            // Back 15 and forward 30 in the notification and on the lock screen, like the app's buttons.
            .setMediaButtonPreferences(
                listOf(
                    CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
                        .setDisplayName("Back 15 seconds")
                        .setPlayerCommand(Player.COMMAND_SEEK_BACK)
                        .setSlots(CommandButton.SLOT_BACK)
                        .build(),
                    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
                        .setDisplayName("Forward 30 seconds")
                        .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                        .setSlots(CommandButton.SLOT_FORWARD)
                        .build(),
                ),
            )
            .setCallback(object : MediaSession.Callback {
                override fun onAddMediaItems(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: List<MediaItem>,
                ): ListenableFuture<List<MediaItem>> = Futures.immediateFuture(mediaItems.mapNotNull(::resolve))
            })
            .build()
    }

    /** Only our own app's controllers can add items, and only http(s) or file addresses play. */
    private fun resolve(item: MediaItem): MediaItem? {
        val uri: Uri = item.requestMetadata.mediaUri ?: item.localConfiguration?.uri ?: return null
        if (uri.scheme !in setOf("https", "http", "file")) return null
        val extras = item.requestMetadata.extras?.getBundle(EXTRA_HEADERS)
        if (extras != null) {
            headers[uri.toString()] = extras.keySet().associateWith { extras.getString(it).orEmpty() }
        }
        val metadata = item.mediaMetadata.buildUpon().apply {
            if (item.mediaMetadata.artworkData == null) artwork?.let { setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) }
        }.build()
        return item.buildUpon().setUri(uri).setMediaMetadata(metadata).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        session?.takeIf { controllerInfo.packageName == packageName || isSystemController(controllerInfo) }

    /** The notification, lock screen, Bluetooth and Android Auto connect as system controllers. */
    private fun isSystemController(info: MediaSession.ControllerInfo): Boolean =
        info.isTrusted || session?.isMediaNotificationController(info) == true

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away while paused ends the session; while playing, the digest goes on.
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
