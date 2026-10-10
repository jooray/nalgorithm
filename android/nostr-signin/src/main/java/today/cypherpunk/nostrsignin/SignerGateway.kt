package today.cypherpunk.nostrsignin

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.withResumed
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** How the controller talks to a NIP-55 signer. Faked in tests. */
interface SignerGateway {
    suspend fun getPublicKey(signerPackage: String): Nip55.Reply

    suspend fun signEvent(signerPackage: String, event: UnsignedEvent): Nip55.Reply
}

/**
 * The Android [SignerGateway]: content provider first, intents through
 * [SignerActivityBridge]. Keep one per sign-in screen in a ViewModel (it must
 * outlive configuration changes while the signer is in front), and put
 * [SignerActivityBridge] in that screen's composition.
 */
class AndroidSignerGateway(context: Context) : SignerGateway {
    private val appContext = context.applicationContext

    internal class Request(val intent: Intent, val result: CompletableDeferred<ActivityResult>)

    internal val requests = Channel<Request>(Channel.UNLIMITED)

    /** The request whose activity is in front; survives the bridge being recreated. */
    @Volatile internal var inFlight: Request? = null

    override suspend fun getPublicKey(signerPackage: String): Nip55.Reply {
        val result = launch(Nip55.getPublicKeyIntent(signerPackage))
        if (result.resultCode != Activity.RESULT_OK) return Nip55.Reply.Rejected
        val data = result.data ?: return Nip55.Reply.Empty
        return Nip55.parsePublicKey { data.getStringExtra(it) }
    }

    override suspend fun signEvent(signerPackage: String, event: UnsignedEvent): Nip55.Reply {
        withContext(Dispatchers.IO) { Nip55.signViaContentResolver(appContext, signerPackage, event) }?.let { return it }

        var attempt = 0
        while (true) {
            val started = SystemClock.elapsedRealtime()
            val result = launch(Nip55.signEventIntent(event, signerPackage))
            val data = result.data
            if (result.resultCode == Activity.RESULT_OK && data != null) {
                return Nip55.parseSigned(event) { data.getStringExtra(it) }
            }
            // A cancel that arrives within a second, with no data, was not the
            // user: the intent reached a signer window that was still closing.
            // Try once more once things have settled.
            val instant = SystemClock.elapsedRealtime() - started < 1_000 && data == null
            if (instant && attempt++ == 0) {
                delay(400)
                continue
            }
            return Nip55.Reply.Rejected
        }
    }

    private suspend fun launch(intent: Intent): ActivityResult {
        val request = Request(intent, CompletableDeferred())
        requests.send(request)
        return request.result.await()
    }
}

/**
 * Launches the signer's activities for [gateway]. Each intent waits until this
 * screen is RESUMED again, so a new request never lands on a signer window that
 * is still closing (see [Nip55]).
 */
@Composable
fun SignerActivityBridge(gateway: AndroidSignerGateway) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        gateway.inFlight?.let { gateway.inFlight = null; it.result.complete(result) }
    }
    LaunchedEffect(gateway) {
        // A request that was in front while this screen was recreated gets its
        // result through the new launcher above; only new ones are read here.
        gateway.inFlight?.result?.let { runCatching { it.await() } }
        for (request in gateway.requests) {
            lifecycle.withResumed { }
            gateway.inFlight = request
            try {
                launcher.launch(request.intent)
            } catch (e: ActivityNotFoundException) {
                gateway.inFlight = null
                request.result.completeExceptionally(e)
                continue
            }
            runCatching { request.result.await() }
        }
    }
}
