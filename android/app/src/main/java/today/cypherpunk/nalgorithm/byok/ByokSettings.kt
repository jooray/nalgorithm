package today.cypherpunk.nalgorithm.byok

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.engine.pubkeyToHexOrNull

/**
 * Bring-your-own-key settings (web settings.ts AppSettings). The device-wide part
 * (feed order, data saver, digest length, audio cache, client picker) lives in
 * data.DeviceSettings; the learned prompt lives with its identity (Learning.kt).
 */
@Serializable
data class ByokSettings(
    val learnFromLikes: Boolean = true,
    val rememberKey: Boolean = true,
    val npub: String = "",
    val relays: List<String> = listOf("wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"),
    val provider: String = "venice",
    val apiBaseUrl: String = "https://api.venice.ai/api/v1",
    /** Never written with the rest: see [ByokSettingsStore]. */
    @Transient val apiKey: String = "",
    // Cheap, fast, and reliable at the batched-JSON scoring this app does. Keep it pointing
    // at a model that is live in the provider's catalog: a delisted default fails every first run.
    val model: String = "deepseek-v4-flash-0731",
    /** `chat` scores with [model]; `decision` with [decisionModel] on Venice's /decisions. */
    val scorer: String = "chat",
    val decisionModel: String = "jev-latest",
    /** Blank reuses [model]. A digest runs once over ~15 posts, so a stronger model costs little. */
    val digestModel: String = "",
    /** Blank reuses [model]. */
    val learnerModel: String = "",
    val digestTopN: Int = 15,
    val digestForSpeech: Boolean = true,
    /** Relays for the NIP-46 remote-signer handshake. */
    val signerRelays: List<String> = DEFAULT_SIGNER_RELAYS,
    val userPrompt: String = "",
    val hoursBack: Int = 24,
    val batchSize: Int = 20,
    /** Scoring batches in parallel; 1 = sequential. */
    val concurrency: Int = 1,
    /** Rank by itself when the app opens and the stored feed is stale. */
    val autoRefresh: Boolean = true,
    /** TTS model for downloadable audio (e.g. tts-kokoro). Blank: read aloud on the phone only. */
    val ttsModel: String = "",
    val ttsVoice: String = "",
) {
    /** The model that scores, for the chosen scorer. */
    val scoringModel: String get() = if (scorer == "decision") decisionModel else model

    val identityHex: String? get() = pubkeyToHexOrNull(npub.trim())

    companion object {
        val DEFAULT_SIGNER_RELAYS = listOf("wss://nostr.cypherpunk.today", "wss://nos.lol", "wss://relay.primal.net")

        val PROVIDER_URLS = linkedMapOf(
            "venice" to "https://api.venice.ai/api/v1",
            "openrouter" to "https://openrouter.ai/api/v1",
            "ollama" to "http://localhost:11434/v1",
            "custom" to "",
        )

        val PROVIDER_LABELS = linkedMapOf(
            "venice" to "Venice AI",
            "openrouter" to "OpenRouter",
            "ollama" to "Ollama (local)",
            "custom" to "Custom",
        )
    }
}

/** What a provider remembers when the reader switches away and back. Keys are never kept per provider. */
@Serializable
data class ProviderDraft(
    val apiBaseUrl: String = "",
    val model: String = "",
    val digestModel: String = "",
    val learnerModel: String = "",
)

/**
 * Persists [ByokSettings] on this device. The API key is kept only when the reader
 * asks to remember it; otherwise it lives in memory for as long as the app runs.
 */
class ByokSettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("byok_settings", Context.MODE_PRIVATE)
    private var sessionKey = ""
    private val _settings = MutableStateFlow(read())
    val settings: StateFlow<ByokSettings> = _settings.asStateFlow()

    private fun read(): ByokSettings {
        val base = prefs.getString("settings", null)?.let {
            runCatching { AppJson.decodeFromString(ByokSettings.serializer(), it) }.getOrNull()
        } ?: ByokSettings()
        val key = if (base.rememberKey) prefs.getString("apiKey", "") ?: "" else sessionKey
        return base.copy(
            scorer = if (base.scorer == "decision") "decision" else "chat",
            decisionModel = base.decisionModel.ifEmpty { "jev-latest" },
            apiKey = key,
        )
    }

    fun save(settings: ByokSettings) {
        val edit = prefs.edit().putString("settings", AppJson.encodeToString(ByokSettings.serializer(), settings))
        if (settings.rememberKey) {
            edit.putString("apiKey", settings.apiKey)
        } else {
            edit.remove("apiKey")
            sessionKey = settings.apiKey
        }
        edit.apply()
        _settings.value = settings
    }

    fun saveProviderDraft(provider: String, s: ByokSettings) {
        prefs.edit().putString(
            "provider_$provider",
            AppJson.encodeToString(ProviderDraft.serializer(), ProviderDraft(s.apiBaseUrl, s.model, s.digestModel, s.learnerModel)),
        ).apply()
    }

    fun providerDraft(provider: String): ProviderDraft {
        val defaults = ProviderDraft(
            apiBaseUrl = ByokSettings.PROVIDER_URLS[provider] ?: "",
            model = when (provider) {
                "ollama" -> "llama3.2"
                "openrouter" -> "google/gemma-3-27b-it"
                "custom" -> ""
                else -> ByokSettings().model
            },
        )
        val stored = prefs.getString("provider_$provider", null) ?: return defaults
        return runCatching { AppJson.decodeFromString(ProviderDraft.serializer(), stored) }.getOrNull() ?: defaults
    }

    /** Clear all data on this device. */
    fun clear() {
        sessionKey = ""
        prefs.edit().clear().apply()
        _settings.value = ByokSettings()
    }
}
