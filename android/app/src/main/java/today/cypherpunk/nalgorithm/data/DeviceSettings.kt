package today.cypherpunk.nalgorithm.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.ui.notes.ClientPreset

/**
 * Settings of this device that apply in both modes (web: the device part of
 * AppSettings — feedOrder, dataSaver, digestMinutes, cacheAudio, the client
 * picker). Defaults are web/src/settings.ts DEFAULTS.
 */
@Serializable
data class DeviceSettings(
    /** "new" (new arrivals first, then best match) or "best". */
    val feedOrder: String = "new",
    val dataSaver: Boolean = false,
    /** Digest length in minutes: 3, 6 or 10. */
    val digestMinutes: Int = 6,
    val cacheAudio: Boolean = true,
    /** client-url.ts preset id. */
    val clientPreset: String = "njump",
    val clientCustomUrl: String = "",
    val clientCustomProfileUrl: String = "",
    /** Playback speed of the digest player. */
    val playbackSpeed: Float = 1f,
    /** Android TTS voice name for Read aloud (BYOK without a TTS model). */
    val speechVoice: String = "",
) {
    /** What loadSettings() guarantees on the web: unknown values fall back instead of leaking through. */
    fun normalized(): DeviceSettings = copy(
        feedOrder = if (feedOrder == "best") "best" else "new",
        digestMinutes = if (digestMinutes in DIGEST_MINUTES) digestMinutes else 6,
        clientPreset = if (ClientPreset.isPreset(clientPreset)) clientPreset else "njump",
        playbackSpeed = if (playbackSpeed.isFinite() && playbackSpeed in 0.5f..3f) playbackSpeed else 1f,
    )

    companion object {
        val DIGEST_MINUTES = listOf(3, 6, 10)
    }
}

/** Persisted in SharedPreferences as one JSON value, so a new field reads with its default. */
class DeviceSettingsStore(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _settings = MutableStateFlow(read())
    val settings: StateFlow<DeviceSettings> = _settings.asStateFlow()

    private fun read(): DeviceSettings {
        val raw = prefs.getString(KEY, null) ?: return DeviceSettings()
        return runCatching { AppJson.decodeFromString(DeviceSettings.serializer(), raw).normalized() }.getOrDefault(DeviceSettings())
    }

    @Synchronized
    fun update(change: (DeviceSettings) -> DeviceSettings) {
        val next = change(_settings.value).normalized()
        if (next == _settings.value) return
        _settings.value = next
        prefs.edit().putString(KEY, AppJson.encodeToString(DeviceSettings.serializer(), next)).apply()
    }

    /** After "Clear this device": back to the defaults, in memory too. */
    fun reset() {
        prefs.edit().clear().apply()
        _settings.value = DeviceSettings()
    }

    companion object {
        const val PREFS = "device_settings"
        private const val KEY = "settings"
    }
}
