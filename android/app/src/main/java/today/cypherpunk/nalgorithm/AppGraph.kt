package today.cypherpunk.nalgorithm

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import today.cypherpunk.nalgorithm.audio.DigestAudio
import today.cypherpunk.nalgorithm.byok.ByokController
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.data.DeviceSettingsStore
import today.cypherpunk.nalgorithm.data.FeedbackStore
import today.cypherpunk.nalgorithm.hosted.HostedApi
import today.cypherpunk.nalgorithm.hosted.HostedController
import today.cypherpunk.nalgorithm.mode.ModeController
import today.cypherpunk.nalgorithm.mode.ModeStore
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.nostr.NoteActions
import today.cypherpunk.nalgorithm.nostr.ProfileCache
import today.cypherpunk.nalgorithm.nostr.RelayPool
import today.cypherpunk.nalgorithm.nostr.SignerManager
import today.cypherpunk.nalgorithm.ui.shell.Toaster
import java.util.concurrent.TimeUnit

/**
 * Every long-lived object in the app, created once in [NalgorithmApp]. Parts
 * reach each other only through here, so each can be built and tested alone.
 */
class AppGraph(context: Context) {
    val context: Context = context.applicationContext

    /** Application-lifetime scope (main thread). Work that must outlive a screen runs here. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    val records = RecordStore(this.context)
    val modeStore = ModeStore(this.context)
    val toasts = Toaster()
    val deviceSettings = DeviceSettingsStore(this.context)

    val relayPool = RelayPool(http)
    val signers = SignerManager(this.context, relayPool, records)
    val profiles = ProfileCache(relayPool, records)
    val feedback = FeedbackStore(this)
    val noteActions = NoteActions(this)

    val hostedApi = HostedApi(http, BuildConfig.HOSTED_BASE, this.context)
    val hosted: HostedController by lazy { HostedController(this) }
    val byok: ByokController by lazy { ByokController(this) }

    val audio by lazy { DigestAudio(this) }

    fun controller(mode: AppMode): ModeController = if (mode == AppMode.Hosted) hosted else byok

    /** The running mode's controller, or null on the choice screen. */
    val active: ModeController? get() = modeStore.mode.value?.let(::controller)
}
