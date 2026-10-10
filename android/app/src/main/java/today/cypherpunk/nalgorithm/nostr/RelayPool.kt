package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import today.cypherpunk.nalgorithm.model.NostrEvent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.Json as KJson

/** One relay's verdict on a published event (web: note-logic.ts RelayResult). */
data class RelayResult(val relay: String, val ok: Boolean, val error: String? = null)

// ─── Transport (a seam for tests) ────────────────────────────────────────────

internal interface RelaySocket {
    fun send(text: String): Boolean
    fun close()
}

internal interface RelaySocketListener {
    fun onOpen()
    fun onMessage(text: String)
    /** The connection is gone (failed TLS, refused, dropped, closed). Called once. */
    fun onGone(reason: String)
}

internal fun interface RelayTransport {
    /** Start connecting; messages sent before the socket opens are queued. Null when the URL cannot be used. */
    fun open(url: String, listener: RelaySocketListener): RelaySocket?
}

internal class OkHttpTransport(http: OkHttpClient) : RelayTransport {
    // The upgrade must answer quickly; after it, OkHttp clears the read timeout for the socket.
    private val client = http.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    override fun open(url: String, listener: RelaySocketListener): RelaySocket? {
        val request = try {
            Request.Builder().url(url).build()
        } catch (e: IllegalArgumentException) {
            return null
        }
        val ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                listener.onGone(reason.ifBlank { "closed by the relay" })
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onGone(reason.ifBlank { "closed" })
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = response?.let { "HTTP ${it.code}" } ?: t.message ?: t.javaClass.simpleName
                listener.onGone(why)
            }
        })
        return object : RelaySocket {
            override fun send(text: String) = ws.send(text)
            override fun close() {
                ws.close(1000, null)
            }
        }
    }
}

// ─── Filters ─────────────────────────────────────────────────────────────────

internal fun Filter.toJson(): JsonObject = buildJsonObject {
    ids?.let { l -> putJsonArray("ids") { l.forEach { add(JsonPrimitive(it)) } } }
    authors?.let { l -> putJsonArray("authors") { l.forEach { add(JsonPrimitive(it)) } } }
    kinds?.let { l -> putJsonArray("kinds") { l.forEach { add(JsonPrimitive(it)) } } }
    e?.let { l -> putJsonArray("#e") { l.forEach { add(JsonPrimitive(it)) } } }
    p?.let { l -> putJsonArray("#p") { l.forEach { add(JsonPrimitive(it)) } } }
    for ((name, values) in tags) putJsonArray("#$name") { values.forEach { add(JsonPrimitive(it)) } }
    since?.let { put("since", it) }
    until?.let { put("until", it) }
    limit?.let { put("limit", it) }
}

/** NIP-01 filter match. Relays send what they like; anything outside the filter is dropped. */
internal fun Filter.matches(event: NostrEvent): Boolean {
    if (ids != null && event.id !in ids) return false
    if (kinds != null && event.kind !in kinds) return false
    if (authors != null && event.pubkey !in authors) return false
    if (since != null && event.createdAt < since) return false
    if (until != null && event.createdAt > until) return false
    fun tagMatch(name: String, values: List<String>) = event.tags.any { it.size > 1 && it[0] == name && it[1] in values }
    if (e != null && !tagMatch("e", e)) return false
    if (p != null && !tagMatch("p", p)) return false
    for ((name, values) in tags) if (!tagMatch(name, values)) return false
    return true
}

/** A relay URL as a connection key: ws(s) only, no trailing slash. Null when unusable. */
internal fun relayKey(url: String): String? {
    val u = url.trim()
    if (u.length > 300 || !(u.startsWith("wss://", true) || u.startsWith("ws://", true))) return null
    if (u.any { it.isWhitespace() }) return null
    val scheme = u.substringBefore("://").lowercase()
    val rest = u.substringAfter("://")
    val host = rest.substringBefore('/')
    val path = rest.substring(host.length).trimEnd('/')
    if (host.isEmpty()) return null
    return "$scheme://${host.lowercase()}$path"
}

// ─── One relay connection ────────────────────────────────────────────────────

internal interface SubHandler {
    fun onEvent(event: NostrEvent)
    fun onEose()
    /** The relay ended the subscription (CLOSED) or the connection died. */
    fun onClosed(reason: String)
}

internal class RelayConnection(
    val url: String,
    private val transport: RelayTransport,
    private val verify: (NostrEvent) -> Boolean,
    private val onDead: (RelayConnection) -> Unit,
) : RelaySocketListener {
    private class Sub(val filters: List<Filter>, val handler: SubHandler)

    private val lock = Any()
    private var socket: RelaySocket? = null
    @Volatile var dead = false
        private set
    private var goneHandled = false
    @Volatile private var goneReason: String? = null
    private val subs = ConcurrentHashMap<String, Sub>()
    private val oks = ConcurrentHashMap<String, MutableList<(Boolean, String) -> Unit>>()
    var users = 0
    var idleJob: Job? = null

    fun connect() {
        synchronized(lock) {
            if (socket != null || dead) return
            socket = transport.open(url, this)
            if (socket == null) dead = true
        }
        if (dead) onGone("invalid relay URL")
    }

    private fun send(text: String): Boolean = synchronized(lock) { if (dead) false else socket?.send(text) ?: false }

    fun subscribe(id: String, filters: List<Filter>, handler: SubHandler) {
        if (dead) {
            handler.onClosed(goneReason ?: "connection failed")
            return
        }
        subs[id] = Sub(filters, handler)
        val frame = buildJsonArray {
            add(JsonPrimitive("REQ")); add(JsonPrimitive(id)); filters.forEach { add(it.toJson()) }
        }.toString()
        // A socket that refuses the frame is going away; onGone reports why.
        if (!send(frame) && dead) subs.remove(id)?.handler?.onClosed(goneReason ?: "connection failed")
    }

    fun unsubscribe(id: String) {
        if (subs.remove(id) != null) send(buildJsonArray { add(JsonPrimitive("CLOSE")); add(JsonPrimitive(id)) }.toString())
    }

    fun publish(event: NostrEvent, onResult: (Boolean, String) -> Unit) {
        if (dead) {
            onResult(false, goneReason ?: "connection failed")
            return
        }
        oks.getOrPut(event.id) { java.util.Collections.synchronizedList(ArrayList()) }.add(onResult)
        if (!send("[\"EVENT\",${event.toWireJson()}]") && dead) {
            oks.remove(event.id)?.forEach { it(false, goneReason ?: "connection failed") }
        }
    }

    fun forgetPublish(id: String) {
        oks.remove(id)
    }

    fun close() {
        val s = synchronized(lock) { socket.also { socket = null } }
        s?.close()
        onGone("closed")
    }

    override fun onOpen() = Unit

    override fun onMessage(text: String) {
        if (text.length > MAX_MESSAGE_CHARS) return
        val arr = runCatching { relayJson.parseToJsonElement(text) as? JsonArray }.getOrNull() ?: return
        val type = (arr.getOrNull(0) as? JsonPrimitive)?.contentOrNull ?: return
        when (type) {
            "EVENT" -> {
                val subId = (arr.getOrNull(1) as? JsonPrimitive)?.contentOrNull ?: return
                val sub = subs[subId] ?: return
                val event = parseEvent(arr.getOrNull(2)) ?: return
                if (sub.filters.none { it.matches(event) }) return
                if (!verify(event)) return
                sub.handler.onEvent(event)
            }
            "EOSE" -> {
                val subId = (arr.getOrNull(1) as? JsonPrimitive)?.contentOrNull ?: return
                subs[subId]?.handler?.onEose()
            }
            "CLOSED" -> {
                val subId = (arr.getOrNull(1) as? JsonPrimitive)?.contentOrNull ?: return
                val reason = (arr.getOrNull(2) as? JsonPrimitive)?.contentOrNull.orEmpty()
                subs.remove(subId)?.handler?.onClosed(reason.ifBlank { "closed by the relay" })
            }
            "OK" -> {
                val id = (arr.getOrNull(1) as? JsonPrimitive)?.contentOrNull ?: return
                val ok = (arr.getOrNull(2) as? JsonPrimitive)?.booleanOrNull ?: return
                val message = (arr.getOrNull(3) as? JsonPrimitive)?.contentOrNull.orEmpty()
                oks.remove(id)?.forEach { it(ok, message) }
            }
            // NOTICE and AUTH: nothing to do. NIP-42 relays answer with CLOSED/OK
            // "auth-required:", which ends the request like any other refusal.
            else -> Unit
        }
    }

    override fun onGone(reason: String) {
        synchronized(lock) {
            if (goneReason == null) goneReason = reason
            dead = true
            socket = null
            if (goneHandled) return
            goneHandled = true
        }
        val s = subs.values.toList()
        subs.clear()
        s.forEach { it.handler.onClosed(reason) }
        val pending = oks.values.toList()
        oks.clear()
        pending.forEach { list -> list.toList().forEach { it(false, reason) } }
        onDead(this)
    }

    companion object {
        const val MAX_MESSAGE_CHARS = 4_000_000
    }
}

internal val relayJson = KJson { ignoreUnknownKeys = true }

/** A live multi-relay subscription; [close] ends it everywhere. */
interface RelaySubscription {
    fun close()
}

/**
 * Shared WebSocket connections to relays (one per relay, closed after a quiet
 * minute), with NIP-01 REQ/EOSE/CLOSED/OK handling. Every incoming event is
 * checked against the filter and its signature before anyone sees it; invalid
 * ones are dropped. A relay that refuses, fails TLS or never answers only ever
 * costs its own share of a timeout.
 */
class RelayPool internal constructor(
    private val transport: RelayTransport,
    private val verify: (NostrEvent) -> Boolean = NostrEvent::verify,
    private val idleMs: Long = IDLE_MS,
) : RelayPoolApi {
    constructor(http: OkHttpClient) : this(OkHttpTransport(http))

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val connections = HashMap<String, RelayConnection>()
    private val serial = AtomicLong()
    private val prefix = Hex.encode(randomBytes(4))

    private fun nextSubId() = "nal$prefix${serial.incrementAndGet()}"

    /** A connection for [url], held until [release]. Null when the URL is not a relay URL. */
    private fun acquire(url: String): RelayConnection? {
        val key = relayKey(url) ?: return null
        val conn = synchronized(connections) {
            val existing = connections[key]?.takeIf { !it.dead }
            val c = existing ?: RelayConnection(key, transport, verify) { gone ->
                synchronized(connections) { if (connections[gone.url] === gone) connections.remove(gone.url) }
            }.also { connections[key] = it }
            c.users++
            c.idleJob?.cancel()
            c.idleJob = null
            c
        }
        conn.connect()
        return conn
    }

    private fun release(conn: RelayConnection) {
        synchronized(connections) {
            conn.users--
            if (conn.users > 0) return
            conn.idleJob?.cancel()
            conn.idleJob = scope.launch {
                delay(idleMs)
                val close = synchronized(connections) {
                    if (conn.users <= 0 && connections[conn.url] === conn) {
                        connections.remove(conn.url)
                        true
                    } else {
                        false
                    }
                }
                if (close) conn.close()
            }
        }
    }

    override suspend fun query(relays: List<String>, filters: List<Filter>, timeoutMs: Long): List<NostrEvent> {
        val urls = relays.mapNotNull(::relayKey).distinct()
        if (urls.isEmpty() || filters.isEmpty() || timeoutMs <= 0) return emptyList()
        val found = java.util.Collections.synchronizedMap(LinkedHashMap<String, NostrEvent>())
        val held = ArrayList<Pair<RelayConnection, String>>()
        val done = urls.map { CompletableDeferred<Unit>() }
        try {
            urls.forEachIndexed { i, url ->
                val conn = acquire(url)
                if (conn == null) {
                    done[i].complete(Unit)
                    return@forEachIndexed
                }
                val subId = nextSubId()
                synchronized(held) { held.add(conn to subId) }
                conn.subscribe(subId, filters, object : SubHandler {
                    override fun onEvent(event: NostrEvent) {
                        found.putIfAbsent(event.id, event)
                    }
                    override fun onEose() {
                        done[i].complete(Unit)
                    }
                    override fun onClosed(reason: String) {
                        done[i].complete(Unit)
                    }
                })
            }
            withTimeoutOrNull(timeoutMs) { done.awaitAll() }
        } finally {
            synchronized(held) {
                for ((conn, subId) in held) {
                    conn.unsubscribe(subId)
                    release(conn)
                }
            }
        }
        return synchronized(found) { found.values.toList() }
    }

    override suspend fun get(relays: List<String>, filter: Filter, timeoutMs: Long): NostrEvent? =
        query(relays, listOf(filter.copy(limit = 1)), timeoutMs).maxByOrNull { it.createdAt }

    override suspend fun publish(relays: List<String>, event: NostrEvent, timeoutMs: Long): Map<String, Boolean> =
        publishDetailed(relays, event, timeoutMs).associate { it.relay to it.ok }

    /**
     * Publish to every relay, one verdict per relay once each answered or timed
     * out (web: relays.ts publishEvent). [onResult] fires as each lands, so a
     * screen can say "Sent" at the first success and keep counting.
     */
    suspend fun publishDetailed(
        relays: List<String>,
        event: NostrEvent,
        timeoutMs: Long = 8_000,
        onResult: ((RelayResult, List<RelayResult>) -> Unit)? = null,
    ): List<RelayResult> = coroutineScope {
        val results = java.util.Collections.synchronizedList(ArrayList<RelayResult>())
        relays.distinct().map { relay ->
            async {
                val conn = acquire(relay)
                val result = if (conn == null) {
                    RelayResult(relay, false, "not a relay address")
                } else {
                    val answer = CompletableDeferred<Pair<Boolean, String>>()
                    try {
                        conn.publish(event) { ok, message -> answer.complete(ok to message) }
                        val r = withTimeoutOrNull(timeoutMs) { answer.await() }
                        when {
                            r == null -> RelayResult(relay, false, "timed out")
                            r.first -> RelayResult(relay, true)
                            else -> RelayResult(relay, false, r.second.removePrefix("connection failure: ").take(160).ifBlank { "refused" })
                        }
                    } finally {
                        conn.forgetPublish(event.id)
                        release(conn)
                    }
                }
                val snapshot = synchronized(results) { results.add(result); results.toList() }
                onResult?.invoke(result, snapshot)
                result
            }
        }.awaitAll()
        synchronized(results) { results.toList() }
    }

    /**
     * A subscription that keeps going until [RelaySubscription.close]: a relay
     * that drops the connection or ends the request is asked again, with
     * backoff. The REQ frames are queued before this returns, so an event
     * published right after cannot outrun them on the same relay.
     */
    fun open(relays: List<String>, filters: List<Filter>, onEvent: (NostrEvent) -> Unit): RelaySubscription {
        val seen = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
        val deliver: (NostrEvent) -> Unit = { event ->
            val fresh = synchronized(seen) {
                val added = seen.add(event.id)
                if (seen.size > 5000) seen.iterator().let { it.next(); it.remove() }
                added
            }
            if (fresh) onEvent(event)
        }
        val workers = relays.mapNotNull(::relayKey).distinct().map { url -> RelayWorker(url, filters, deliver) }
        workers.forEach { it.start() }
        return object : RelaySubscription {
            override fun close() = workers.forEach { it.stop() }
        }
    }

    private inner class RelayWorker(val url: String, val filters: List<Filter>, val deliver: (NostrEvent) -> Unit) {
        @Volatile private var stopped = false
        private var current: Pair<RelayConnection, String>? = null
        private var backoffMs = 1_000L
        private var retry: Job? = null

        fun start() {
            if (stopped) return
            val conn = acquire(url) ?: return
            val subId = nextSubId()
            synchronized(this) { current = conn to subId }
            conn.subscribe(subId, filters, object : SubHandler {
                override fun onEvent(event: NostrEvent) {
                    backoffMs = 1_000L
                    deliver(event)
                }
                override fun onEose() {
                    backoffMs = 1_000L
                }
                override fun onClosed(reason: String) {
                    val held = synchronized(this@RelayWorker) { current.also { current = null } }
                    held?.let { release(it.first) }
                    if (stopped) return
                    val wait = backoffMs
                    backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                    retry = scope.launch {
                        delay(wait)
                        start()
                    }
                }
            })
        }

        fun stop() {
            stopped = true
            retry?.cancel()
            val held = synchronized(this) { current.also { current = null } }
            held?.let { (conn, subId) ->
                conn.unsubscribe(subId)
                release(conn)
            }
        }
    }

    override fun subscribe(relays: List<String>, filters: List<Filter>): Flow<NostrEvent> = callbackFlow {
        val sub = open(relays, filters) { trySend(it) }
        awaitClose { sub.close() }
    }

    companion object {
        const val IDLE_MS = 60_000L
    }
}
