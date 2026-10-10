package today.cypherpunk.nalgorithm.ui.tune

import android.content.Context
import android.content.Intent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.data.DeviceSettings
import today.cypherpunk.nalgorithm.data.FeedbackState
import today.cypherpunk.nalgorithm.data.SavedNote
import today.cypherpunk.nalgorithm.data.StoredRule
import today.cypherpunk.nalgorithm.model.AppMode
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * device-data.ts: what this device keeps, and taking it away. The export holds
 * the settings (the model key only when separately asked) and the private
 * feedback; signer secrets never.
 */
object DeviceData {
    private val pretty = Json(AppJson) { prettyPrint = true }

    fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    private fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    /** Only this device's preferences: in hosted mode everything else lives on the server (Download my hosted data). */
    fun deviceJson(s: DeviceSettings): JsonObject = buildJsonObject {
        put("feedOrder", s.feedOrder)
        put("dataSaver", s.dataSaver)
        put("digestMinutes", s.digestMinutes)
        put("cacheAudio", s.cacheAudio)
        put("clientPreset", s.clientPreset)
        put("clientCustomUrl", s.clientCustomUrl)
        put("clientCustomProfileUrl", s.clientCustomProfileUrl)
    }

    fun exportJson(graph: AppGraph, mode: AppMode?, modeSettings: JsonElement?): String =
        build(mode, graph.deviceSettings.settings.value, graph.feedback.state.value, modeSettings, isoNow())

    /** The export file's content (pure, for tests). BYOK: the mode's settings over this device's. */
    fun build(mode: AppMode?, device: DeviceSettings, feedback: FeedbackState, modeSettings: JsonElement?, exportedAt: String): String {
        val settings = if (mode == AppMode.Byok && modeSettings is JsonObject) {
            JsonObject(deviceJson(device) + modeSettings.jsonObject)
        } else {
            deviceJson(device)
        }
        val root = buildJsonObject {
            put("app", "nalgorithm")
            put("exportedAt", exportedAt)
            put("mode", JsonPrimitive(when (mode) { AppMode.Hosted -> "hosted"; AppMode.Byok -> "byok"; null -> "choose" }))
            put("settings", settings)
            put("feedback", buildJsonObject {
                put("rules", AppJson.encodeToJsonElement(ListSerializer(StoredRule.serializer()), feedback.rules))
                put("muted", AppJson.encodeToJsonElement(ListSerializer(String.serializer()), feedback.muted))
                put("saved", AppJson.encodeToJsonElement(ListSerializer(SavedNote.serializer()), feedback.saved))
            })
        }
        return pretty.encodeToString(JsonObject.serializer(), root)
    }

    /**
     * Everything this app keeps on the phone: preferences, records, signer
     * connections, cached audio and files. The app restarts afterwards, so no
     * part of it can write its state back from memory.
     */
    suspend fun clear(graph: AppGraph) {
        runCatching { graph.signers.forget() }
        runCatching { graph.audio.clearCache() }
        graph.records.clear("")
        graph.feedback.forgetAll()
        graph.deviceSettings.reset()
        withContext(Dispatchers.IO) {
            val context = graph.context
            val prefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
            for (file in prefsDir.listFiles().orEmpty()) {
                val name = file.name.removeSuffix(".xml")
                context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
                context.deleteSharedPreferences(name)
            }
            for (dir in listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir)) {
                dir.listFiles()?.forEach { it.deleteRecursively() }
            }
        }
    }

    /** Start afresh, as the web reloads the page after clearing. */
    fun restart(context: Context) {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (intent != null) context.startActivity(intent)
        Runtime.getRuntime().exit(0)
    }
}
