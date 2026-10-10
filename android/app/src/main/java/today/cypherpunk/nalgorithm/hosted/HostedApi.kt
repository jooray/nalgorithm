package today.cypherpunk.nalgorithm.hosted

import android.content.Context
import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.nostr.NostrSigner
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Every failed call, whatever the cause. [status] is 0 when the network failed. */
class ApiError(
    val status: Int,
    override val message: String,
    val code: String? = null,
    /** The rest of the error body (for example `startedAt` on a 409 digest_running). */
    val data: JsonObject = JsonObject(emptyMap()),
) : Exception(message)

/** Where the session lives. Private SharedPreferences in the app; a map in tests. */
interface SessionStore {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

private class PrefsSessionStore(context: Context) : SessionStore {
    private val prefs = context.getSharedPreferences("hosted_session", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

data class Me(val npub: String, val entitlement: Entitlement)

data class Challenge(val nonce: String, val url: String, val expiresAt: Long?)

data class HostedSettings(
    val userPrompt: String = "",
    val hoursBack: Int = 24,
    val topN: Int = 15,
    val learnFromLikes: Boolean = true,
    /** Absent from older servers, meaning on. */
    val linkPreviews: Boolean? = null,
    /** Absent from older servers, meaning 6. */
    val digestMinutes: Int? = null,
    val feedback: List<FeedbackRule>? = null,
)

/** One ranking as the server sends it: posts trimmed of their raw events, with the profiles they need. */
data class FeedResponse(
    val entitlement: Entitlement,
    val fetched: Int,
    val hoursBack: Int,
    val posts: List<ScoredPost>,
    val profiles: Map<String, ProfileData>,
    /** Unix seconds of the run this ranking came from. */
    val createdAt: Long?,
    val cached: Boolean,
    /** The prompt or window changed since this ranking was made. */
    val settingsChanged: Boolean,
)

sealed interface LatestFeed {
    data class Unchanged(val settingsChanged: Boolean, val entitlement: Entitlement) : LatestFeed
    data class Snapshot(val feed: FeedResponse) : LatestFeed
}

data class Charge(val invoiceId: String, val checkoutUrl: String?, val sats: Long?)

data class Learned(val prompt: String, val updatedAt: String?)

sealed interface DigestList {
    data class Unchanged(val etag: String?) : DigestList
    data class Fresh(val digests: List<DigestRecord>, val etag: String?) : DigestList
}

/**
 * The hosted server's API (`<app>/api/`), authenticated with the session token as
 * `Authorization: Bearer`. The web keeps the session in an HttpOnly cookie; the app
 * keeps the token from the login answer in private preferences instead, and drops it
 * as soon as the server says it is no longer valid.
 */
class HostedApi internal constructor(http: OkHttpClient, val baseUrl: String, private val store: SessionStore) {
    constructor(http: OkHttpClient, baseUrl: String, context: Context) : this(http, baseUrl, PrefsSessionStore(context))

    private val json: Json = AppJson
    private val client = http.newBuilder().callTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    /** A feed run can take about a minute; leave room beyond that. */
    private val feedClient = http.newBuilder().callTimeout(FEED_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(FEED_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** The session token, or null when signed out. */
    val token: String? get() = store.get(KEY_TOKEN)

    /** The account of the session (hex, as the server names it), or null. */
    val sessionNpub: String? get() = store.get(KEY_NPUB)

    /**
     * The account last signed in on this device. It outlives a 401 (so its remembered
     * ranking can be shown offline at the next start), and goes at sign-out.
     */
    var lastNpub: String?
        get() = store.get(KEY_LAST)
        set(value) = store.set(KEY_LAST, value)

    /** Headers for a request that needs the session (audio downloads, preview images, voice samples). */
    fun authHeaders(): Map<String, String> = token?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()

    /** Forget the session on this device (401, logout, deleted account). */
    fun forgetSession() {
        store.set(KEY_TOKEN, null)
        store.set(KEY_NPUB, null)
    }

    fun url(path: String): String = baseUrl + path

    // ─── Requests ────────────────────────────────────────────────────────────

    private class Answer(val status: Int, val body: JsonElement?, val etag: String?)

    private suspend fun request(
        method: String,
        path: String,
        body: JsonElement? = null,
        feed: Boolean = false,
        etag: String? = null,
    ): Answer {
        val builder = Request.Builder().url(url(path))
        token?.let { builder.header("Authorization", "Bearer $it") }
        if (method == "GET") {
            if (etag != null) builder.header("If-None-Match", etag)
            builder.get()
        } else {
            // The server requires a JSON content type on every write, bodyless or not.
            val text = json.encodeToString(JsonElement.serializer(), body ?: JsonObject(emptyMap()))
            builder.method(method, text.toRequestBody(JSON_TYPE))
        }
        val call = (if (feed) feedClient else client).newCall(builder.build())
        val res = try {
            call.await()
        } catch (e: IOException) {
            throw ApiError(0, if (e is InterruptedIOException) "The server took too long to answer." else (e.message ?: "Network error"), "network")
        }
        val (status, text, tag, statusText) = try {
            withContext(Dispatchers.IO) {
                res.use { r -> Quad(r.code, if (r.code == 304) "" else r.body.string(), r.header("ETag"), r.message) }
            }
        } catch (e: IOException) {
            throw ApiError(0, if (e is InterruptedIOException) "The server took too long to answer." else (e.message ?: "Network error"), "network")
        }
        if (status == 304) return Answer(304, null, tag)
        // A non-JSON body (a proxy error page, say) falls through to the status.
        val data = runCatching { json.parseToJsonElement(text) }.getOrNull()
        if (status !in 200..299) {
            if (status == 401) forgetSession()
            val o = data as? JsonObject ?: JsonObject(emptyMap())
            val error = (o["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val code = (o["code"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            throw ApiError(status, error ?: statusText.ifEmpty { "HTTP $status" }, code, o)
        }
        return Answer(status, data, tag)
    }

    private data class Quad(val code: Int, val text: String, val etag: String?, val message: String)

    private fun JsonElement?.obj(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())
    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.number(key: String): Double? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.content?.toDoubleOrNull()?.takeIf { it.isFinite() }
    private fun JsonObject.bool(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()

    // ─── Auth ────────────────────────────────────────────────────────────────

    suspend fun challenge(): Challenge {
        val o = request("POST", "auth/challenge").body.obj()
        val nonce = o.string("nonce") ?: throw ApiError(500, "The server sent no login challenge.")
        val url = o.string("url") ?: throw ApiError(500, "The server sent no login challenge.")
        return Challenge(nonce, url, o.number("expires_at")?.toLong())
    }

    /**
     * Log in by signing the server's challenge. The first login creates the account
     * (sign-up); the trial starts with the first feed.
     *
     * The challenge is fetched only now, right before signing, because the server
     * accepts a login event for about a minute after its `created_at`. The signed
     * event must be from the key the person connected: a signer that answers as
     * some other key would otherwise log them in as a stranger.
     */
    suspend fun loginWithSigner(signer: NostrSigner, expectedPubkey: String, now: () -> Long = { System.currentTimeMillis() / 1000 }): String {
        val challenge = challenge()
        val template = buildLoginTemplate(signer.pubkey, challenge.url, challenge.nonce, now())
        val event = signer.sign(template)
        if (event.kind != LOGIN_EVENT_KIND || !verifyEvent(event)) {
            throw IllegalStateException("The signer returned an invalid login signature.")
        }
        if (!event.pubkey.equals(expectedPubkey, ignoreCase = true)) {
            throw IllegalStateException("The signer signed with a different key than the one you connected. Try again.")
        }
        val o = request("POST", "auth/login", buildJsonObject { put("event", json.encodeToJsonElement(NostrEvent.serializer(), event)) }).body.obj()
        val token = o.string("token") ?: throw ApiError(500, "The server did not start a session.")
        val npub = o.string("npub") ?: event.pubkey
        store.set(KEY_TOKEN, token)
        store.set(KEY_NPUB, npub)
        lastNpub = npub
        return npub
    }

    /** Ends the session on the server; this device forgets it whatever the answer. */
    suspend fun logout() {
        try {
            request("POST", "auth/logout")
        } finally {
            forgetSession()
        }
    }

    suspend fun me(): Me {
        val o = request("GET", "me").body.obj()
        val npub = o.string("npub") ?: throw ApiError(500, "The server did not say who you are.")
        store.set(KEY_NPUB, npub)
        return Me(npub, Entitlement.read(o["entitlement"]))
    }

    // ─── Settings, feed, billing ─────────────────────────────────────────────

    private fun readSettings(v: JsonElement?): HostedSettings {
        val o = v.obj()
        val d = HostedSettings()
        return HostedSettings(
            userPrompt = o.string("userPrompt") ?: d.userPrompt,
            hoursBack = o.number("hoursBack")?.toInt() ?: d.hoursBack,
            topN = o.number("topN")?.toInt() ?: d.topN,
            learnFromLikes = o.bool("learnFromLikes") ?: d.learnFromLikes,
            linkPreviews = o.bool("linkPreviews"),
            digestMinutes = o.number("digestMinutes")?.toInt(),
            feedback = (o["feedback"] as? JsonArray)?.mapNotNull { r ->
                val ro = r as? JsonObject ?: return@mapNotNull null
                val kind = ro.string("kind")?.takeIf { it == FeedbackRule.MORE || it == FeedbackRule.LESS } ?: return@mapNotNull null
                FeedbackRule(kind, ro.string("excerpt") ?: return@mapNotNull null)
            },
        )
    }

    suspend fun settings(): HostedSettings = readSettings(request("GET", "settings").body)

    /** A partial update: only the given fields change. */
    suspend fun putSettings(patch: JsonObject): HostedSettings = readSettings(request("PUT", "settings", patch).body)

    suspend fun putFeedback(rules: List<FeedbackRule>): HostedSettings = putSettings(
        buildJsonObject { put("feedback", json.encodeToJsonElement(rules)) },
    )

    private fun readPosts(v: JsonElement?): List<ScoredPost> =
        (v as? JsonArray)?.mapNotNull { runCatching { json.decodeFromJsonElement<ScoredPost>(it) }.getOrNull() } ?: emptyList()

    private fun readProfiles(v: JsonElement?): Map<String, ProfileData> {
        val o = v as? JsonObject ?: return emptyMap()
        val out = LinkedHashMap<String, ProfileData>()
        for ((pk, p) in o) {
            if (!HEX_PUBKEY.matches(pk) || p !is JsonObject) continue
            val key = pk.lowercase()
            out[key] = ProfileData(key, p.string("name"), p.string("picture"), p.string("nip05"), p.string("lud16"), p.string("lud06"))
        }
        return out
    }

    private fun readFeed(o: JsonObject, entitlement: Entitlement): FeedResponse = FeedResponse(
        entitlement = entitlement,
        fetched = o.number("fetched")?.toInt() ?: 0,
        hoursBack = o.number("hoursBack")?.toInt() ?: 24,
        posts = readPosts(o["posts"]),
        profiles = readProfiles(o["profiles"]),
        createdAt = o.number("createdAt")?.toLong(),
        cached = o.bool("cached") == true,
        settingsChanged = o.bool("settingsChanged") == true,
    )

    /** Rank the feed. [force] skips the server's 2-minute "just did that" shortcut (the Refresh button). */
    suspend fun feed(limit: Int = 100, force: Boolean = false): FeedResponse {
        val o = request("GET", "feed?limit=$limit${if (force) "&force=1" else ""}", feed = true).body.obj()
        return readFeed(o, Entitlement.read(o["entitlement"]))
    }

    /**
     * The last ranking the server stored for this person, or null. Never ranks, never uses the daily cap.
     * With [since] (the ranking already on this device), an unchanged one answers without its posts.
     */
    suspend fun latestFeed(since: Long?): LatestFeed? {
        val o = request("GET", "feed/latest${if (since != null && since > 0) "?since=$since" else ""}").body.obj()
        val ent = Entitlement.read(o["entitlement"])
        if (o.bool("unchanged") == true) return LatestFeed.Unchanged(o.bool("settingsChanged") == true, ent)
        val snap = o["snapshot"] as? JsonObject ?: return null
        return LatestFeed.Snapshot(readFeed(snap, ent))
    }

    suspend fun checkout(plan: Plan, sats: Long?): Charge {
        val o = request("POST", "billing/checkout", buildJsonObject {
            put("plan", plan.id)
            if (sats != null) put("sats", sats)
            // After paying, the server's return page opens nalgorithm://billing, which closes the tab.
            put("return", "app")
        }).body.obj()
        return Charge(o.string("invoice_id") ?: "", o.string("checkout_url"), o.number("sats")?.toLong())
    }

    /** What the reader's feed run is doing right now: fetching, waiting in line or ranking. */
    suspend fun feedProgress(): FeedProgress = readFeedProgress(request("GET", "feed/progress").body)

    // ─── Link previews ───────────────────────────────────────────────────────

    suspend fun preview(pageUrl: String): LinkCard? = readLinkCard(request("GET", "preview?url=${enc(pageUrl)}").body)

    /** The address of a preview image path the server issued (already vetted by [safeImagePath]). */
    fun previewImageUrl(path: String): String = url(path)

    // ─── Daily digest ────────────────────────────────────────────────────────

    private fun readSchedule(v: JsonElement?): Schedule {
        val o = v.obj()
        val d = Schedule()
        return Schedule(
            enabled = o.bool("enabled") ?: d.enabled,
            time = o.string("time") ?: d.time,
            tz = o.string("tz") ?: d.tz,
            voice = o.string("voice"),
            dmFormat = o.string("dmFormat")?.takeIf { it == "nip17" || it == "nip04" },
            nextRunAt = o.number("nextRunAt")?.toLong(),
            lastRunAt = o.number("lastRunAt")?.toLong(),
            lastStatus = o.string("lastStatus"),
        )
    }

    suspend fun schedule(): Schedule = readSchedule(request("GET", "schedule").body)

    /**
     * A partial update. [voice] and [dmFormat] are sent as null when [sendVoiceAndFormat]:
     * the default voice, and the format of the person's last message.
     */
    suspend fun putSchedule(
        enabled: Boolean? = null,
        time: String? = null,
        tz: String? = null,
        voice: String? = null,
        dmFormat: String? = null,
        sendVoiceAndFormat: Boolean = false,
    ): Schedule = readSchedule(request("PUT", "schedule", buildJsonObject {
        if (enabled != null) put("enabled", enabled)
        if (time != null) put("time", time)
        if (tz != null) put("tz", tz)
        if (sendVoiceAndFormat) {
            put("voice", voice?.let(::JsonPrimitive) ?: JsonNull)
            put("dmFormat", dmFormat?.let(::JsonPrimitive) ?: JsonNull)
        }
    }).body)

    /** What the server keeps for this account, as pretty-printed JSON text. */
    suspend fun exportAccount(): String {
        val data = request("GET", "account/export").body ?: JsonObject(emptyMap())
        return PRETTY.encodeToString(JsonElement.serializer(), data)
    }

    /** Delete what the server keeps for this account; the session ends with it. */
    suspend fun deleteAccount() {
        request("POST", "account/delete", buildJsonObject { put("confirm", "delete") })
        forgetSession()
    }

    /** The taste learned from the reader's likes ("" when none). */
    suspend fun learned(): Learned {
        val o = request("GET", "learned").body.obj()
        return Learned(o.string("prompt") ?: "", o.string("updatedAt"))
    }

    /** Forget the learned taste; only likes from now on shape a new one. */
    suspend fun resetLearned() {
        request("POST", "learned/reset")
    }

    /** Where a voice's short sample plays from (only the shortlisted voices have one). */
    fun voiceSampleUrl(voice: String): String = url("voices/${enc(voice)}/sample")

    /** The server's proxy for a digest's audio (needs [authHeaders]). */
    fun digestAudioUrl(id: String): String = url("digests/${enc(id)}/audio")

    /**
     * The newest digests. [summary] leaves out the show notes (fetched per digest with
     * [digest]); [etag] is the answer last seen, and an unchanged list comes back as
     * [DigestList.Unchanged] with no body to parse.
     */
    suspend fun digests(limit: Int, summary: Boolean = false, etag: String? = null): DigestList {
        val a = request("GET", "digests?limit=$limit${if (summary) "&summary=1" else ""}", etag = etag)
        if (a.status == 304 || a.body == null) return DigestList.Unchanged(a.etag ?: etag)
        val list = (a.body.obj()["digests"] as? JsonArray)?.mapNotNull(::readDigest) ?: emptyList()
        return DigestList.Fresh(list, a.etag)
    }

    /** One digest with its show notes. Null when the server has no such digest. */
    suspend fun digest(id: String): DigestRecord? {
        val res = request("GET", "digests/${enc(id)}").body
        // The contract is the single object; tolerate it wrapped as { digest }.
        val body = (res as? JsonObject)?.takeIf { it.containsKey("digest") }?.get("digest") ?: res
        return readDigest(body)
    }

    /** The digest is made in the background and arrives by DM. The answer carries the job's status. */
    suspend fun digestNow(): Pair<String, DigestStatus> {
        val body = request("POST", "digest/now").body
        return (body.obj().string("message") ?: "") to DigestStatus.read(body)
    }

    /** Whether a digest is being written, since when, and how long the last one took. */
    suspend fun digestStatus(): DigestStatus = DigestStatus.read(request("GET", "digest/status").body)

    companion object {
        const val DEFAULT_TIMEOUT_MS = 30_000L
        const val FEED_TIMEOUT_MS = 180_000L
        private const val KEY_TOKEN = "token"
        private const val KEY_NPUB = "npub"
        private const val KEY_LAST = "last_npub"
        private val JSON_TYPE = "application/json".toMediaType()
        private val HEX_PUBKEY = Regex("^[0-9a-fA-F]{64}$")
        private val PRETTY = Json { prettyPrint = true }

        private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        /** NIP-01: the id is the hash of the serialized event, and the signature is a valid Schnorr signature over it. */
        fun verifyEvent(event: NostrEvent): Boolean = runCatching {
            val expected = UnsignedEvent(event.pubkey, event.createdAt, event.kind, event.tags, event.content).id
            if (!expected.equals(event.id, ignoreCase = true)) return false
            Secp256k1.verifySchnorr(hex(event.sig), hex(event.id), hex(event.pubkey))
        }.getOrDefault(false)

        private fun hex(s: String): ByteArray {
            require(s.length % 2 == 0)
            return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        }
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }
    })
}
