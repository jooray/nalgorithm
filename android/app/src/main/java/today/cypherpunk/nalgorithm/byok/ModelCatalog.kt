package today.cypherpunk.nalgorithm.byok

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import today.cypherpunk.nalgorithm.core.AppJson
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

@Serializable
data class ModelInfo(
    val id: String,
    val contextTokens: Long? = null,
    /** USD per million input tokens. */
    val inputUsd: Double? = null,
    /** USD per million output tokens. */
    val outputUsd: Double? = null,
)

data class SuggestedModels(val scoring: String? = null, val digest: String? = null, val learner: String? = null)

/**
 * The provider's model list (web models.ts), so model fields offer real choices.
 * Typing stays allowed: the catalog is a convenience, not an allowlist.
 */
object ModelCatalog {
    private const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L

    @Serializable
    private data class CatalogCache(val fetchedAt: Long, val models: List<ModelInfo>)

    fun isVenice(apiBaseUrl: String): Boolean = Regex("(^|//|\\.)venice\\.ai", RegexOption.IGNORE_CASE).containsMatchIn(apiBaseUrl)

    /**
     * Models known to work well for each role, best first: the scoring model must emit strict
     * batched JSON reliably, which price and context do not predict.
     */
    private val VENICE_SCORING = listOf("deepseek-v4-flash-0731", "deepseek-v4-flash", "google-gemma-3-27b-it", "qwen3-6-27b")
    private val VENICE_DIGEST = listOf("kimi-k3", "kimi-k2-6", "claude-sonnet-5-5", "qwen-3-6-plus")
    private val VENICE_LEARNER = listOf("kimi-k3", "kimi-k2-6", "qwen-3-6-plus")

    /** Sensible per-role models from a fetched catalog. Venice only for now. */
    fun suggestModels(apiBaseUrl: String, models: List<ModelInfo>): SuggestedModels {
        if (!isVenice(apiBaseUrl)) return SuggestedModels()
        val available = models.map { it.id }.toSet()
        fun first(list: List<String>) = list.firstOrNull { it in available }
        return SuggestedModels(first(VENICE_SCORING), first(VENICE_DIGEST), first(VENICE_LEARNER))
    }

    private fun base(apiBaseUrl: String) = apiBaseUrl.replace(Regex("/+$"), "")
    private fun prefs(context: Context) = context.getSharedPreferences("byok_models", Context.MODE_PRIVATE)

    fun loadCached(context: Context, apiBaseUrl: String, now: Long = System.currentTimeMillis()): List<ModelInfo>? {
        val raw = prefs(context).getString(base(apiBaseUrl), null) ?: return null
        val cache = runCatching { AppJson.decodeFromString(CatalogCache.serializer(), raw) }.getOrNull() ?: return null
        return if (now - cache.fetchedAt > CACHE_TTL_MS) null else cache.models
    }

    private fun saveCached(context: Context, apiBaseUrl: String, models: List<ModelInfo>) {
        prefs(context).edit().putString(base(apiBaseUrl), AppJson.encodeToString(CatalogCache.serializer(), CatalogCache(System.currentTimeMillis(), models))).apply()
    }

    /** Venice nests details under model_spec; plain OpenAI-compatible servers give little beyond id. */
    internal fun normalize(entry: JsonObject): ModelInfo? {
        val id = (entry["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() } ?: return null
        val spec = entry["model_spec"] as? JsonObject ?: return ModelInfo(id)
        fun num(o: JsonObject?, key: String) = (o?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
        val pricing = spec["pricing"] as? JsonObject
        return ModelInfo(
            id = id,
            contextTokens = num(spec, "availableContextTokens")?.toLong(),
            inputUsd = num(pricing?.get("input") as? JsonObject, "usd"),
            outputUsd = num(pricing?.get("output") as? JsonObject, "usd"),
        )
    }

    internal fun parseList(body: String): List<ModelInfo> {
        val root = AppJson.parseToJsonElement(body) as? JsonObject ?: return emptyList()
        // `data` is the OpenAI shape; `models` is what a few local servers return.
        val raw = (root["data"] as? JsonArray) ?: (root["models"] as? JsonArray) ?: return emptyList()
        return raw.mapNotNull { (it as? JsonObject)?.let(::normalize) }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.id })
    }

    /** The provider's model list; [force] skips the day-long cache. */
    suspend fun fetchModels(context: Context, http: OkHttpClient, apiBaseUrl: String, apiKey: String, force: Boolean = false): List<ModelInfo> {
        val b = base(apiBaseUrl)
        if (b.isEmpty()) throw Exception("Set the API base URL first")
        if (!force) loadCached(context, b)?.let { return it }
        // Venice serves text, image, TTS and embedding models from one endpoint; only text ones apply.
        val url = if (isVenice(b)) "$b/models?type=text" else "$b/models"
        val request = try {
            Request.Builder().url(url).get().apply { if (apiKey.isNotEmpty()) header("Authorization", "Bearer $apiKey") }.build()
        } catch (_: IllegalArgumentException) {
            throw Exception("Could not reach $url.")
        }
        val client = http.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()
        val body = try {
            withContext(Dispatchers.IO) {
                client.newCall(request).execute().use { res ->
                    if (!res.isSuccessful) {
                        throw Exception(if (res.code == 401 || res.code == 403) "Model list rejected the API key" else "Model list failed (HTTP ${res.code})")
                    }
                    res.body.string()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: InterruptedIOException) {
            throw Exception("Model list request timed out")
        } catch (e: java.io.IOException) {
            throw Exception("Could not reach $url.")
        }
        val models = runCatching { parseList(body) }.getOrDefault(emptyList())
        if (models.isEmpty()) throw Exception("Provider returned no models")
        saveCached(context, b, models)
        return models
    }

    fun clear(context: Context) = prefs(context).edit().clear().apply()

    /** A short label, e.g. "1M ctx · $0.18/$0.35 per M". */
    fun describe(model: ModelInfo): String {
        val bits = mutableListOf<String>()
        model.contextTokens?.takeIf { it > 0 }?.let { ctx ->
            bits.add(if (ctx >= 1_000_000) "${Math.round(ctx / 1_000_000.0)}M ctx" else "${Math.round(ctx / 1000.0)}k ctx")
        }
        if (model.inputUsd != null && model.outputUsd != null) bits.add("$${fmt(model.inputUsd)}/$${fmt(model.outputUsd)} per M")
        return bits.joinToString(" · ")
    }

    private fun fmt(d: Double) = if (d == Math.rint(d)) d.toLong().toString() else d.toString()
}
