package today.cypherpunk.nalgorithm.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale

/**
 * Read aloud with the phone's own speech engine (web/src/speech.ts): no TTS provider,
 * no API key, and no audio leaves the device.
 *
 * Every chunk is queued at once, so the engine keeps reading with the screen off even
 * while the app is not scheduled; each chunk's start reports progress. The engine has
 * no pause: pausing stops, and resuming starts again from the chunk that was playing.
 */
class SpeechEngine(context: Context) {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ready: CompletableDeferred<Boolean>? = null
    private var session = 0
    private var focus: AudioFocusRequest? = null
    private var noisyRegistered = false

    /** Called when another app takes the audio or headphones are unplugged: the player pauses. */
    var onInterrupted: () -> Unit = {}

    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) onInterrupted()
        }
    }

    /** The engine's own limit, under which every chunk must stay. */
    fun maxChunkChars(): Int = minOf(MAX_CHUNK_CHARS, runCatching { TextToSpeech.getMaxSpeechInputLength() }.getOrDefault(MAX_CHUNK_CHARS))

    private suspend fun engine(): TextToSpeech? {
        val existing = ready
        if (existing != null) return if (existing.await()) tts else null
        val deferred = CompletableDeferred<Boolean>()
        ready = deferred
        tts = TextToSpeech(context) { status -> deferred.complete(status == TextToSpeech.SUCCESS) }
        val ok = withTimeoutOrNull(8000) { deferred.await() } == true
        if (!ok) {
            tts?.shutdown()
            tts = null
            ready = null
        }
        return if (ok) tts else null
    }

    /**
     * Speak [chunks] from [start]. [onProgress] gets the index of the chunk that starts,
     * [onEnd] runs after the last one, [onError] with a message for the reader.
     */
    suspend fun speak(
        chunks: List<String>,
        start: Int,
        rate: Float,
        voiceName: String,
        onProgress: (Int) -> Unit,
        onEnd: () -> Unit,
        onError: (String) -> Unit,
    ) {
        stop()
        val mine = ++session
        val engine = engine()
        if (mine != session) return
        if (engine == null) {
            onError("This phone has no speech engine to read the digest aloud. Install one in Android settings, under Text-to-speech output.")
            return
        }
        val voice: Voice? = voiceName.takeIf { it.isNotEmpty() }?.let { name -> runCatching { engine.voices?.firstOrNull { it.name == name } }.getOrNull() }
        runCatching { engine.voice = voice ?: engine.defaultVoice }
        engine.setAudioAttributes(attributes)
        engine.setSpeechRate(rate)
        engine.setPitch(1f)
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            private fun indexOf(id: String?): Int? {
                val parts = id?.split(':') ?: return null
                if (parts.size != 3 || parts[0] != "nal" || parts[1].toIntOrNull() != mine) return null
                return parts[2].toIntOrNull()
            }
            override fun onStart(utteranceId: String?) {
                val i = indexOf(utteranceId) ?: return
                main.post { if (mine == session) onProgress(i) }
            }
            override fun onDone(utteranceId: String?) {
                val i = indexOf(utteranceId) ?: return
                if (i == chunks.size - 1) main.post { if (mine == session) { release(); onEnd() } }
            }
            override fun onStop(utteranceId: String?, interrupted: Boolean) = Unit
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = onError(utteranceId, TextToSpeech.ERROR)
            override fun onError(utteranceId: String?, errorCode: Int) {
                indexOf(utteranceId) ?: return
                main.post { if (mine == session) { stop(); onError("Speech failed: ${errorText(errorCode)}") } }
            }
        })
        if (!acquire()) {
            onError("Another app is using the audio. Press play to try again.")
            return
        }
        for (i in start until chunks.size) {
            val result = engine.speak(chunks[i], TextToSpeech.QUEUE_ADD, null, "nal:$mine:$i")
            if (result != TextToSpeech.SUCCESS) {
                stop()
                onError("Speech failed: the engine refused the text")
                return
            }
        }
    }

    fun stop() {
        session++
        runCatching { tts?.stop() }
        release()
    }

    fun shutdown() {
        stop()
        tts?.shutdown()
        tts = null
        ready = null
    }

    private fun acquire(): Boolean {
        val am = context.getSystemService(AudioManager::class.java) ?: return true
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) main.post { onInterrupted() }
            }
            .build()
        focus = request
        if (!noisyRegistered) {
            ContextCompat.registerReceiver(context, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
            noisyRegistered = true
        }
        return am.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_FAILED
    }

    private fun release() {
        focus?.let { context.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(it) }
        focus = null
        if (noisyRegistered) {
            runCatching { context.unregisterReceiver(noisy) }
            noisyRegistered = false
        }
    }

    private fun errorText(code: Int): String = when (code) {
        TextToSpeech.ERROR_NETWORK, TextToSpeech.ERROR_NETWORK_TIMEOUT -> "the voice needs a network connection"
        TextToSpeech.ERROR_NOT_INSTALLED_YET -> "the voice is not installed yet"
        TextToSpeech.ERROR_OUTPUT -> "audio output error"
        TextToSpeech.ERROR_SYNTHESIS -> "the engine could not synthesize the text"
        TextToSpeech.ERROR_SERVICE -> "the speech service stopped"
        TextToSpeech.ERROR_INVALID_REQUEST -> "invalid request"
        else -> "error $code"
    }
}

/** One voice of the phone's speech engine, for the Read aloud voice picker in Tune. */
data class SpeechVoice(
    /** The engine's id for it; this is what DeviceSettings.speechVoice stores. */
    val name: String,
    /** BCP 47 tag, "en-US". */
    val lang: String,
    /** "English (United States)" in the reader's language. */
    val language: String,
    val needsNetwork: Boolean,
    /** Engine quality, 100 (very low) to 500 (very high). */
    val quality: Int,
)

object SpeechVoices {
    /**
     * Every installed voice, sorted by language then name (like the web's listVoices).
     * Empty when the phone has no engine. Voices load with the engine, so this waits for it.
     */
    suspend fun list(context: Context, timeoutMs: Long = 4000): List<SpeechVoice> {
        val ready = CompletableDeferred<Boolean>()
        val tts = TextToSpeech(context.applicationContext) { ready.complete(it == TextToSpeech.SUCCESS) }
        return try {
            if (withTimeoutOrNull(timeoutMs) { ready.await() } != true) return emptyList()
            val voices = runCatching { tts.voices }.getOrNull().orEmpty()
            voices
                .filter { !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
                .map {
                    SpeechVoice(
                        name = it.name,
                        lang = it.locale.toLanguageTag(),
                        language = it.locale.getDisplayName(Locale.getDefault()),
                        needsNetwork = it.isNetworkConnectionRequired,
                        quality = it.quality,
                    )
                }
                .sortedWith(compareBy<SpeechVoice> { it.lang }.thenBy { it.name })
        } finally {
            tts.shutdown()
        }
    }
}
