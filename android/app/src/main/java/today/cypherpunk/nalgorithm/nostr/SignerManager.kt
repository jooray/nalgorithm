package today.cypherpunk.nalgorithm.nostr

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.withResumed
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nostrsignin.AndroidSignerGateway
import today.cypherpunk.nostrsignin.Nip55
import today.cypherpunk.nostrsignin.SignerActivityBridge
import java.util.concurrent.ConcurrentHashMap

/**
 * Who can sign for the reader, on this device (web: signer.ts).
 *
 * Two separate facts: the reader (whose key the app is for, which a mode
 * knows) and the signer (something that can sign for that key right now): a
 * NIP-55 app on this phone or a NIP-46 remote signer. A reader without a
 * signer still sees every action; tapping one asks them to connect one, and a
 * signer for another key is refused rather than published under the wrong name.
 *
 * Connections are remembered per pubkey: the NIP-55 signer's package, or the
 * NIP-46 client key (sealed by the Android Keystore), the signer's routing key
 * and relays. The client key can only ask the signer, which answers within the
 * permissions it was given. Disconnect forgets them.
 */
class SignerManager(context: Context, private val pool: RelayPool, private val records: RecordStore) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** NIP-55 plumbing; [SignerHost] puts its activity bridge in the composition. */
    val gateway = AndroidSignerGateway(appContext)

    /** Default NIP-46 relays (web: DEFAULT_SIGNER_RELAYS); BYOK may override them in Tune. */
    var signerRelays: List<String> = Nip46.DEFAULT_SIGNER_RELAYS

    private val active = ConcurrentHashMap<String, NostrSigner>()

    /** A sign-in sheet [SignerHost] should show, or null. */
    class SheetRequest(
        val purpose: SignInPurpose,
        val expectedPubkey: String?,
        internal val result: CompletableDeferred<SignInResult?> = CompletableDeferred(),
    )

    private val _sheet = MutableStateFlow<SheetRequest?>(null)
    val sheet: StateFlow<SheetRequest?> = _sheet.asStateFlow()

    /** A signer for [pubkey] that is connected or can be restored without UI (saved NIP-46 session, remembered NIP-55 app). */
    suspend fun signerFor(pubkey: String): NostrSigner? {
        val pk = pubkey.lowercase()
        active[pk]?.let { return it }
        val stored = records.get(recordKey(pk), StoredSigner.serializer()) ?: return null
        val signer: NostrSigner = when (stored.type) {
            StoredSigner.NIP55 -> {
                val pkg = stored.pkg ?: return null
                val installed = Nip55.signers(appContext).firstOrNull { it.packageName == pkg }
                    // Some signers answer for a package other than the one listed for nostrsigner:.
                    ?: Nip55.SignerApp(pkg, stored.label ?: "Signer").takeIf { isInstalled(pkg) }
                    ?: return null
                Nip55Signer(pk, pkg, installed.label, gateway)
            }
            StoredSigner.NIP46 -> {
                val saved = stored.sealed?.let(SecretBox::open)?.let(SavedRemoteSigner::parse)?.takeIf { it.user == pk } ?: return null
                resume(saved)
            }
            else -> return null
        }
        return active.putIfAbsent(pk, signer) ?: signer
    }

    private fun isInstalled(pkg: String): Boolean = runCatching { appContext.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    /** The connection a previous launch made, ready to sign again without a new scan. */
    private fun resume(saved: SavedRemoteSigner): RemoteSigner =
        remoteSigner(RemoteSignerSession(pool, Hex.decode(saved.client), saved.remote, saved.relays), saved.user)

    /**
     * Ask the reader to connect a signer: shows the sign-in sheet (rendered by
     * [SignerHost]) and suspends until it succeeds (result) or is dismissed (null).
     * With [expectedPubkey], a signer for another key is refused.
     */
    suspend fun requestSigner(purpose: SignInPurpose, expectedPubkey: String? = null): SignInResult? {
        val request = SheetRequest(purpose, expectedPubkey?.lowercase())
        _sheet.value?.result?.complete(null)
        _sheet.value = request
        return try {
            request.result.await()
        } finally {
            _sheet.compareAndSet(request, null)
        }
    }

    /** The sheet finished: keep what it produced (unless it is for the wrong key, which the sheet checks). */
    internal fun finishSheet(request: SheetRequest, result: SignInResult?) {
        if (result != null) remember(result)
        request.result.complete(result)
        _sheet.compareAndSet(request, null)
    }

    /** Remember a connected signer for later sessions. */
    fun remember(result: SignInResult) {
        val signer = result.signer ?: return
        val pk = result.pubkey.lowercase()
        active.put(pk, signer)?.takeIf { it !== signer }?.close()
        scope.launch {
            when (signer) {
                is Nip55Signer -> records.put(recordKey(pk), StoredSigner.serializer(), StoredSigner(StoredSigner.NIP55, pkg = signer.packageName, label = signer.label))
                is RemoteSigner -> {
                    val saved = signer.saved()
                    if (saved.user != pk) return@launch
                    val sealed = SecretBox.seal(AppJson.encodeToString(SavedRemoteSigner.serializer(), saved)) ?: return@launch
                    records.put(recordKey(pk), StoredSigner.serializer(), StoredSigner(StoredSigner.NIP46, sealed = sealed))
                }
                else -> Unit
            }
        }
    }

    /** "Disconnect signer": forget the connection on this device (all, or one pubkey). */
    fun forget(pubkey: String? = null) {
        if (pubkey == null) {
            active.values.forEach { it.close() }
            active.clear()
            scope.launch { records.clear(RECORD_PREFIX) }
        } else {
            val pk = pubkey.lowercase()
            active.remove(pk)?.close()
            scope.launch { records.delete(recordKey(pk)) }
        }
    }

    // ─── What the sign-in panel uses ─────────────────────────────────────────

    internal class PublicKeyRequest(val intent: Intent, val result: CompletableDeferred<ActivityResult>)

    internal val publicKeyRequests = Channel<PublicKeyRequest>(Channel.UNLIMITED)

    /** The request whose signer activity is in front; outlives the activity being recreated. */
    @Volatile internal var publicKeyInFlight: PublicKeyRequest? = null

    /**
     * NIP-55 `get_public_key`, asking the signer to allow the kinds [purpose]
     * signs, so the signatures that follow can run silently through its content
     * provider. Goes through [SignerHost]'s launcher, which waits until the app
     * is in front again before it launches anything.
     */
    internal suspend fun nip55PublicKey(signerPackage: String, purpose: SignInPurpose): Nip55.Reply {
        val request = PublicKeyRequest(publicKeyIntent(signerPackage, purpose), CompletableDeferred())
        publicKeyRequests.send(request)
        val result = request.result.await()
        if (result.resultCode != Activity.RESULT_OK) return Nip55.Reply.Rejected
        val data = result.data ?: return Nip55.Reply.Empty
        return Nip55.parsePublicKey { data.getStringExtra(it) }
    }

    internal fun nip55Signer(pubkey: String, signerPackage: String, label: String) = Nip55Signer(pubkey, signerPackage, label, gateway)

    internal fun handshake(purpose: SignInPurpose, onAuthUrl: (String) -> Unit) =
        NostrConnectHandshake(pool, signerRelays, Nip46.signKinds(purpose).map { "sign_event:$it" }, onAuthUrl)

    internal suspend fun bunker(pointer: Nip46.BunkerPointer, purpose: SignInPurpose, onAuthUrl: (String) -> Unit) =
        connectBunker(pool, pointer, Nip46.signKinds(purpose).map { "sign_event:$it" }, onAuthUrl)

    /** A finished NIP-46 handshake as a sign-in result. Identity-only sign-ins close the connection at once (nostr-login.ts). */
    internal fun remoteResult(purpose: SignInPurpose, session: RemoteSignerSession, user: String): SignInResult {
        if (purpose == SignInPurpose.ByokIdentity) {
            session.close()
            return SignInResult(user, null)
        }
        return SignInResult(user, remoteSigner(session, user))
    }

    private fun remoteSigner(session: RemoteSignerSession, user: String): RemoteSigner {
        lateinit var signer: RemoteSigner
        signer = RemoteSigner(user, session) { message ->
            // Revoked in the signer, or it never answered: the next tap offers a fresh connection.
            if (!SavedRemoteSigner.keepAfterSignError(message)) {
                active.remove(user, signer)
                scope.launch { records.delete(recordKey(user)) }
                session.close()
            }
        }
        return signer
    }

    @Serializable
    internal data class StoredSigner(
        val type: String,
        val pkg: String? = null,
        val label: String? = null,
        /** Sealed SavedRemoteSigner JSON. */
        val sealed: String? = null,
    ) {
        companion object {
            const val NIP55 = "nip55"
            const val NIP46 = "nip46"
        }
    }

    companion object {
        private const val RECORD_PREFIX = "signer:"
        private fun recordKey(pubkey: String) = "$RECORD_PREFIX$pubkey"

        /** NIP-55 permissions JSON for a purpose (empty: identity only). */
        fun permissionsJson(purpose: SignInPurpose): String? {
            val kinds = Nip46.signKinds(purpose)
            if (kinds.isEmpty()) return null
            return kinds.joinToString(",", "[", "]") { "{\"type\":\"sign_event\",\"kind\":$it}" }
        }

        fun publicKeyIntent(signerPackage: String, purpose: SignInPurpose): Intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
                setPackage(signerPackage)
                putExtra("type", "get_public_key")
                permissionsJson(purpose)?.let { putExtra("permissions", it) }
            }
    }
}

/**
 * Launches NIP-55 `get_public_key` intents for [manager]. Like the module's
 * bridge, each waits until the app is RESUMED, so it never lands on a signer
 * window that is still closing.
 */
@Composable
internal fun PublicKeyBridge(manager: SignerManager) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        manager.publicKeyInFlight?.let { manager.publicKeyInFlight = null; it.result.complete(result) }
    }
    LaunchedEffect(manager) {
        manager.publicKeyInFlight?.result?.let { runCatching { it.await() } }
        for (request in manager.publicKeyRequests) {
            lifecycle.withResumed { }
            manager.publicKeyInFlight = request
            try {
                launcher.launch(request.intent)
            } catch (e: ActivityNotFoundException) {
                manager.publicKeyInFlight = null
                request.result.completeExceptionally(e)
                continue
            }
            runCatching { request.result.await() }
        }
    }
}

/** Put once at the root of the UI: renders sign-in sheets requested by [SignerManager.requestSigner] and hosts the NIP-55 activity bridge. */
@Composable
fun SignerHost(manager: SignerManager) {
    SignerActivityBridge(manager.gateway)
    PublicKeyBridge(manager)
    SignInSheet(manager)
}

/** The inline sign-in choices (signer on this phone, nostrconnect QR/link, bunker, npub for BYOK). */
@Composable
fun SignInPanel(manager: SignerManager, purpose: SignInPurpose, onResult: (SignInResult) -> Unit, modifier: Modifier = Modifier) {
    SignInPanelContent(manager, purpose, onResult, modifier)
}
