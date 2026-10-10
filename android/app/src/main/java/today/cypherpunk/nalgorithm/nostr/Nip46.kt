package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * NIP-46 remote signing, client side (web: nostr-login.ts over nostr-tools'
 * BunkerSigner, signer.ts, signer-store.ts).
 *
 * On the pubkey: the `pubkey` on the signer's kind-24133 frames is a
 * per-connection routing key, not the reader's identity. Newer Amber builds
 * make a fresh one per connection, so treating it as the npub would sign the
 * reader in as an ephemeral key that follows nobody. `get_public_key` is the
 * only correct source.
 */
object Nip46 {
    const val KIND = 24133

    /**
     * Relays used for the NIP-46 handshake. Multiple, because relays go down.
     * Every entry was verified to round-trip an ephemeral kind-24133 event
     * (publish on one connection, receive on another): a relay can accept the
     * event and never relay it, which looks exactly like a signer that never
     * answered. relay.nsec.app returned HTTP 502 and relay.damus.io would not
     * complete the handshake when this list was set; re-probe before adding one.
     */
    val DEFAULT_SIGNER_RELAYS = listOf("wss://nostr.cypherpunk.today", "wss://nos.lol", "wss://relay.primal.net")

    /** How long to wait for the user to approve in their signer app. */
    const val APPROVAL_TIMEOUT_MS = 180_000L

    /** How long to wait for the signer to answer a sign request. */
    const val SIGN_TIMEOUT_MS = 120_000L

    /** The kind of the hosted login event (an HTTP auth event, NIP-98 style). */
    const val LOGIN_EVENT_KIND = 27235

    /** The event kinds the note actions sign: reply, boost, like, generic boost, zap request. */
    val ACTION_SIGN_KINDS = listOf(1, 6, 7, 16, 9734)

    const val APP_NAME = "Nalgorithm"
    const val APP_URL = "https://nalgorithm.cypherpunk.today"
    const val APP_IMAGE = "https://nalgorithm.cypherpunk.today/app/icon-512.png"

    const val CANCELLED = "Signer login cancelled or timed out. Scan the code again to retry."
    const val SIGN_TIMEOUT = "The signer did not answer the sign request in time."

    /** The kinds a purpose asks a signer to allow (login-ui.ts). Empty: identity only, no signing. */
    fun signKinds(purpose: SignInPurpose): List<Int> = when (purpose) {
        SignInPurpose.HostedLogin -> listOf(LOGIN_EVENT_KIND) + ACTION_SIGN_KINDS
        SignInPurpose.Actions -> ACTION_SIGN_KINDS
        SignInPurpose.ByokIdentity -> emptyList()
    }

    /** nostr-tools createNostrConnectURI, with URLSearchParams encoding. */
    fun nostrConnectUri(
        clientPubkey: String,
        relays: List<String>,
        secret: String,
        perms: List<String>,
        name: String? = APP_NAME,
        url: String? = APP_URL,
        image: String? = APP_IMAGE,
    ): String {
        val q = mutableListOf<String>()
        relays.forEach { q += "relay=" + NoteLogic.formEncode(it) }
        q += "secret=" + NoteLogic.formEncode(secret)
        if (perms.isNotEmpty()) q += "perms=" + NoteLogic.formEncode(perms.joinToString(","))
        name?.let { q += "name=" + NoteLogic.formEncode(it) }
        url?.let { q += "url=" + NoteLogic.formEncode(it) }
        image?.let { q += "image=" + NoteLogic.formEncode(it) }
        return "nostrconnect://$clientPubkey?" + q.joinToString("&")
    }

    data class BunkerPointer(val pubkey: String, val relays: List<String>, val secret: String?)

    private val BUNKER_REGEX = Regex("^bunker://([0-9a-f]{64})\\??([?/\\w:.=&%-]*)$")

    /** A bunker:// link, checked locally (nostr-tools BUNKER_REGEX). Null when it is not one, or names no relay. */
    fun parseBunker(input: String): BunkerPointer? {
        val m = BUNKER_REGEX.find(input.trim()) ?: return null
        val relays = mutableListOf<String>()
        var secret: String? = null
        for (part in m.groupValues[2].removePrefix("?").split('&')) {
            if (part.isEmpty()) continue
            val k = decode(part.substringBefore('='))
            val v = decode(part.substringAfter('=', ""))
            when (k) {
                "relay" -> relayKey(v)?.let { if (it !in relays) relays += it }
                "secret" -> if (secret == null) secret = v
            }
        }
        if (relays.isEmpty()) return null
        return BunkerPointer(m.groupValues[1], relays, secret)
    }

    private fun decode(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

    fun isHexPubkey(value: String?): Boolean = value != null && value.length == 64 && value.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }

    /** The JSON a signer is asked to sign (nostr-tools sends the template without a pubkey). */
    fun templateJson(event: UnsignedEvent): String = buildString {
        append("{\"kind\":").append(event.kind)
        append(",\"content\":").append(jsonQuote(event.content))
        append(",\"tags\":").append(event.tags.joinToString(",", "[", "]") { t -> t.joinToString(",", "[", "]") { jsonQuote(it) } })
        append(",\"created_at\":").append(event.createdAt)
        append('}')
    }

    /** A JSON-RPC answer from the signer. */
    data class Response(val id: String, val result: String?, val error: String?)

    fun parseResponse(plaintext: String): Response? {
        val o = runCatching { relayJson.parseToJsonElement(plaintext) as? JsonObject }.getOrNull() ?: return null
        val id = (o["id"] as? JsonPrimitive)?.contentOrNull ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        return Response(id, str("result"), str("error"))
    }

    fun requestJson(id: String, method: String, params: List<String>): String = buildJsonObject {
        put("id", id)
        put("method", method)
        put("params", buildJsonArray { params.forEach { add(JsonPrimitive(it)) } })
    }.toString()

    /** A signed kind-24133 envelope from the client key to [remote]. */
    fun envelope(clientSecret: ByteArray, remote: String, content: String): NostrEvent {
        val pub = Keys.publicHex(clientSecret)
        return signLocal(UnsignedEvent(pub, nowSeconds(), KIND, listOf(listOf("p", remote)), content), clientSecret)
    }

    /**
     * The signed event a signer returned for [asked]: valid signature, our key,
     * and the kind, tags and content we asked for. Throws a readable error otherwise.
     */
    fun checkSigned(json: String, asked: UnsignedEvent): NostrEvent {
        val event = runCatching { parseEvent(relayJson.parseToJsonElement(json)) }.getOrNull()
            ?: throw IllegalStateException("The signer returned something that is not a signed event.")
        if (!event.verify()) throw IllegalStateException("event returned from bunker is improperly signed")
        if (event.kind != asked.kind || event.tags != asked.tags || event.content != asked.content) {
            throw IllegalStateException("The signer returned a different event than the one it was asked to sign.")
        }
        return event
    }
}

/** web: signer-store.ts SavedRemoteSigner. */
@Serializable
data class SavedRemoteSigner(
    val v: Int = 1,
    /** The reader's hex pubkey (from get_public_key), whom the signer signs for. */
    val user: String,
    /** This app's NIP-46 client secret key, hex. */
    val client: String,
    /** The signer's routing pubkey for this connection, hex. */
    val remote: String,
    val relays: List<String>,
) {
    companion object {
        /** Accept a well-formed record only (signer-store.ts parseSavedSigner). */
        fun parse(raw: String?): SavedRemoteSigner? {
            if (raw == null) return null
            val o = runCatching { relayJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
            if ((o["v"] as? JsonPrimitive)?.contentOrNull != "1" || (o["v"] as JsonPrimitive).isString) return null
            fun hex(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(Hex::isHex64)
            val user = hex("user") ?: return null
            val client = hex("client") ?: return null
            val remote = hex("remote") ?: return null
            val arr = o["relays"] as? JsonArray ?: return null
            val relays = arr.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.takeIf { r -> r.startsWith("ws://") || r.startsWith("wss://") } }
            if (relays.isEmpty()) return null
            return SavedRemoteSigner(1, user, client, remote, relays)
        }

        /** A refusal by the reader keeps the connection; anything else (timeout, revoked, gone) drops it. */
        fun keepAfterSignError(message: String): Boolean = Regex("reject|denied|declin|cancel", RegexOption.IGNORE_CASE).containsMatchIn(message)
    }
}

/** The signer answered a request with an error. */
class SignerRpcException(message: String) : Exception(message)

/**
 * An open NIP-46 channel to one remote signer: the client key, the signer's
 * routing pubkey and its relays. Requests are matched to answers by id; an
 * `auth_url` answer is handed to [onAuthUrl] and the request keeps waiting
 * under the same id. The relay subscription opens on the first request.
 */
class RemoteSignerSession(
    private val pool: RelayPool,
    val clientSecret: ByteArray,
    val remotePubkey: String,
    relays: List<String>,
    private val onAuthUrl: (String) -> Unit = {},
) {
    val clientPubkey: String = Keys.publicHex(clientSecret)
    @Volatile var relays: List<String> = relays
        private set
    private val conversationKey = Nip44.conversationKey(clientSecret, remotePubkey)
    private val idPrefix = Hex.encode(randomBytes(4))
    private val serial = AtomicLong()
    private val listeners = ConcurrentHashMap<String, CompletableDeferred<String>>()
    private val waitingForAuth = ConcurrentHashMap.newKeySet<String>()
    private var sub: RelaySubscription? = null
    @Volatile var isOpen = true
        private set
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun ensureSubscription() {
        synchronized(this) {
            if (sub != null) return
            sub = pool.open(relays, listOf(Filter(kinds = listOf(Nip46.KIND), authors = listOf(remotePubkey), p = listOf(clientPubkey), limit = 0)), ::onEvent)
        }
    }

    internal fun onEvent(event: NostrEvent) {
        if (event.pubkey != remotePubkey) return
        val plain = runCatching { Nip44.decrypt(event.content, conversationKey) }.getOrNull() ?: return
        handle(plain)
    }

    internal fun handle(plaintext: String) {
        val r = Nip46.parseResponse(plaintext) ?: return
        if (r.result == "auth_url" && waitingForAuth.remove(r.id)) {
            r.error?.takeIf { NoteLogic.isHttpsUrl(it) }?.let(onAuthUrl)
            return
        }
        val handler = listeners[r.id] ?: return
        when {
            !r.error.isNullOrEmpty() -> handler.completeExceptionally(SignerRpcException(r.error))
            !r.result.isNullOrEmpty() -> handler.complete(r.result)
            else -> return
        }
        listeners.remove(r.id)
        waitingForAuth.remove(r.id)
    }

    /** Send one request and wait for its answer. Throws on error, timeout or when no relay took the request. */
    suspend fun request(method: String, params: List<String>, timeoutMs: Long, timeoutMessage: String): String {
        check(isOpen) { "this signer is not open anymore, create a new one" }
        ensureSubscription()
        val id = "$idPrefix-${serial.incrementAndGet()}"
        val answer = CompletableDeferred<String>()
        listeners[id] = answer
        waitingForAuth.add(id)
        try {
            val event = Nip46.envelope(clientSecret, remotePubkey, Nip44.encrypt(Nip46.requestJson(id, method, params), conversationKey))
            scope.launch {
                val results = pool.publishDetailed(relays, event)
                if (results.none { it.ok }) {
                    answer.completeExceptionally(SignerRpcException("Could not reach the signer's relays (${NoteLogic.describePublish(results)})."))
                }
            }
            return withTimeoutOrNull(timeoutMs) { answer.await() } ?: throw SignerRpcException(timeoutMessage)
        } finally {
            listeners.remove(id)
            waitingForAuth.remove(id)
        }
    }

    suspend fun getPublicKey(timeoutMs: Long = Nip46.APPROVAL_TIMEOUT_MS): String {
        val pk = request("get_public_key", emptyList(), timeoutMs, Nip46.CANCELLED)
        if (!Nip46.isHexPubkey(pk)) throw SignerRpcException("Signer returned an invalid public key")
        return pk.lowercase()
    }

    suspend fun signEvent(event: UnsignedEvent, timeoutMs: Long = Nip46.SIGN_TIMEOUT_MS): NostrEvent {
        val json = request("sign_event", listOf(Nip46.templateJson(event)), timeoutMs, Nip46.SIGN_TIMEOUT)
        return Nip46.checkSigned(json, event)
    }

    /** nostr-tools switchRelays: adopt the signer's preferred relays when it names others. Best-effort. */
    suspend fun switchRelays(timeoutMs: Long = 1_000) {
        val reply = runCatching { request("switch_relays", emptyList(), timeoutMs, "no answer") }.getOrNull() ?: return
        val list = runCatching { relayJson.parseToJsonElement(reply) as? JsonArray }.getOrNull() ?: return
        val urls = list.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.let(::relayKey) }.distinct()
        if (urls.isEmpty() || urls.sorted() == relays.sorted()) return
        synchronized(this) {
            relays = urls
            sub?.close()
            sub = null
        }
    }

    fun saved(user: String) = SavedRemoteSigner(1, user, Hex.encode(clientSecret), remotePubkey, relays)

    fun close() {
        isOpen = false
        synchronized(this) {
            sub?.close()
            sub = null
        }
        listeners.values.forEach { it.completeExceptionally(SignerRpcException(Nip46.CANCELLED)) }
        scope.cancel()
    }
}

/**
 * A client-initiated `nostrconnect://` handshake. Listens for a response whose
 * `result` equals our one-time secret exactly (no "ack", no request-shaped
 * fallback), pins the remote signer that sent it, then asks it for the
 * reader's pubkey with `get_public_key`.
 */
class NostrConnectHandshake(
    private val pool: RelayPool,
    relays: List<String>,
    perms: List<String>,
    private val onAuthUrl: (String) -> Unit = {},
    private val clientSecret: ByteArray = Keys.generateSecret(),
) {
    val clientPubkey = Keys.publicHex(clientSecret)
    private val secret = Hex.encode(randomBytes(32))
    val relays: List<String> = relays.mapNotNull(::relayKey).distinct().ifEmpty { Nip46.DEFAULT_SIGNER_RELAYS }
    val uri: String = Nip46.nostrConnectUri(clientPubkey, this.relays, secret, perms)
    @Volatile private var cancelled = false
    private var pending: CompletableDeferred<String>? = null
    private var session: RemoteSignerSession? = null

    internal fun connectResponseFrom(event: NostrEvent): Boolean {
        val conv = runCatching { Nip44.conversationKey(clientSecret, event.pubkey) }.getOrNull() ?: return false
        val plain = runCatching { Nip44.decrypt(event.content, conv) }.getOrNull() ?: return false
        return Nip46.parseResponse(plain)?.result == secret
    }

    /**
     * Wait for the signer, then learn the reader's pubkey. Returns the open
     * session and the pubkey; throws with the web's message on timeout or cancel.
     */
    suspend fun await(timeoutMs: Long = Nip46.APPROVAL_TIMEOUT_MS): Pair<RemoteSignerSession, String> {
        val remote = CompletableDeferred<String>()
        synchronized(this) {
            if (cancelled) throw SignerRpcException(Nip46.CANCELLED)
            pending = remote
        }
        val sub = pool.open(relays, listOf(Filter(kinds = listOf(Nip46.KIND), p = listOf(clientPubkey), limit = 0))) { event ->
            if (!remote.isCompleted && connectResponseFrom(event)) remote.complete(event.pubkey)
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        val remotePubkey = try {
            withTimeoutOrNull(timeoutMs) { remote.await() } ?: throw SignerRpcException(Nip46.CANCELLED)
        } finally {
            sub.close()
        }
        val session = RemoteSignerSession(pool, clientSecret, remotePubkey, relays, onAuthUrl)
        synchronized(this) {
            if (cancelled) {
                session.close()
                throw SignerRpcException(Nip46.CANCELLED)
            }
            this.session = session
        }
        try {
            session.switchRelays()
            val left = (deadline - System.currentTimeMillis()).coerceAtLeast(5_000)
            val user = session.getPublicKey(left)
            synchronized(this) {
                if (cancelled) throw SignerRpcException(Nip46.CANCELLED)
                finished = true
            }
            return session to user
        } catch (e: Throwable) {
            session.close()
            throw e
        }
    }

    /** Abort the handshake (sheet closed, new code). A session already handed out is not touched. */
    fun cancel() {
        val (p, s) = synchronized(this) {
            cancelled = true
            pending to session
        }
        p?.completeExceptionally(SignerRpcException(Nip46.CANCELLED))
        if (s != null && !finished) s.close()
    }

    @Volatile private var finished = false
}

/**
 * A `bunker://` connection: the signer is known up front, so the client sends
 * `connect` (with the secret and the permissions), then `get_public_key`.
 */
suspend fun connectBunker(
    pool: RelayPool,
    pointer: Nip46.BunkerPointer,
    perms: List<String>,
    onAuthUrl: (String) -> Unit,
    timeoutMs: Long = Nip46.APPROVAL_TIMEOUT_MS,
): Pair<RemoteSignerSession, String> {
    val session = RemoteSignerSession(pool, Keys.generateSecret(), pointer.pubkey, pointer.relays, onAuthUrl)
    try {
        val params = mutableListOf(pointer.pubkey, pointer.secret ?: "")
        if (perms.isNotEmpty()) params += perms.joinToString(",")
        val reply = session.request("connect", params, timeoutMs, Nip46.CANCELLED)
        if (reply != "ack" && (pointer.secret == null || reply != pointer.secret)) {
            throw SignerRpcException("The signer did not accept the connection.")
        }
        val user = session.getPublicKey(timeoutMs)
        return session to user
    } catch (e: Throwable) {
        session.close()
        throw e
    }
}
