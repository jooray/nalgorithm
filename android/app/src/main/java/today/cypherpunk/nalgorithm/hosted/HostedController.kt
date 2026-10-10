package today.cypherpunk.nalgorithm.hosted

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.mode.AppTab
import today.cypherpunk.nalgorithm.mode.AudioSource
import today.cypherpunk.nalgorithm.mode.DigestBackend
import today.cypherpunk.nalgorithm.mode.DigestGeneration
import today.cypherpunk.nalgorithm.mode.DigestListState
import today.cypherpunk.nalgorithm.mode.FeedSource
import today.cypherpunk.nalgorithm.mode.FeedUiState
import today.cypherpunk.nalgorithm.mode.LinkPreview
import today.cypherpunk.nalgorithm.mode.ModeController
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.nostr.SignInResult
import today.cypherpunk.nostrsignin.Bech32
import java.net.URI
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Hosted mode (web/src/hosted/app.ts). The hosted server does the fetching,
 * scoring and billing; this is only the client for it.
 *
 * Flow: read `/me` → signed out shows the login gate. Signed in, the last
 * ranking is drawn at once (from this device, then from the server), and a run
 * starts in the background when that ranking is older than ten minutes. A run
 * starts the free trial and counts against the daily cap, so nothing runs
 * while paywalled, while the app is in the background, or again after a
 * failure without a pause.
 *
 * Everything here runs on the main thread (the graph's scope); network calls suspend.
 */
class HostedController(internal val graph: AppGraph) : ModeController {
    override val mode = AppMode.Hosted
    internal val api: HostedApi get() = graph.hostedApi
    private val scope = graph.scope
    private val prefs = graph.context.getSharedPreferences("hosted", Context.MODE_PRIVATE)

    // ─── Public state for the UI ─────────────────────────────────────────────

    enum class GateState { None, Booting, Login, Startup }

    data class Status(val text: String = "", val isError: Boolean = false)

    /** The red or neutral card above the feed (web #hosted-notice) with its one button. */
    data class Notice(val text: String, val actionLabel: String?, val action: (() -> Unit)?)

    data class Empty(val text: String, val firstRun: Boolean)

    sealed interface StatusLine {
        data class Text(val text: String) : StatusLine
        data class Coverage(val shown: Int, val ranked: Int, val hoursBack: Int) : StatusLine
    }

    /** The Tune form. Numbers stay text until saved, so a half-typed value is not lost. */
    @kotlinx.serialization.Serializable
    data class TuneForm(
        val prompt: String = "",
        val hours: String = "24",
        val topN: String = "15",
        val learn: Boolean = true,
        val previews: Boolean = true,
        val digestEnabled: Boolean = false,
        val digestTime: String = NUDGE_TIME,
        val digestTz: String = "",
        /** "" is the default voice. */
        val digestVoice: String = "",
        /** "" is automatic. */
        val digestFormat: String = "",
    )

    private val _reader = MutableStateFlow<String?>(null)
    override val reader: StateFlow<String?> = _reader.asStateFlow()

    private val _gateActive = MutableStateFlow(false)
    override val gateActive: StateFlow<Boolean> = _gateActive.asStateFlow()
    internal val gate = MutableStateFlow(GateState.None)
    internal val loginStatus = MutableStateFlow(Status())
    internal val signingIn = MutableStateFlow(false)
    internal val startupError = MutableStateFlow("")

    internal val entitlement = MutableStateFlow<Entitlement?>(null)
    internal val notice = MutableStateFlow<Notice?>(null)
    internal val paywall = MutableStateFlow(false)
    internal val payStatus = MutableStateFlow(Status())
    internal val paying = MutableStateFlow(false)
    internal val payLink = MutableStateFlow<String?>(null)
    internal val plan = MutableStateFlow(Plan.Nalgorithm)
    internal val satsText = MutableStateFlow(Plan.Nalgorithm.sats.toString())
    internal val loadingText = MutableStateFlow<String?>(null)
    internal val empty = MutableStateFlow<Empty?>(null)
    internal val statusLine = MutableStateFlow<StatusLine?>(null)

    internal val form = MutableStateFlow(TuneForm())
    internal val learnedText = MutableStateFlow("")
    internal val learnedStatus = MutableStateFlow(Status())
    internal val tuneStatus = MutableStateFlow(Status())
    internal val saving = MutableStateFlow(false)
    internal val firstRunHint = MutableStateFlow(false)
    internal val focusPrompt = MutableStateFlow(0)

    internal val schedule = MutableStateFlow<Schedule?>(null)
    internal val scheduleStatus = MutableStateFlow(Status())
    internal val lastStatusLine = MutableStateFlow("")
    internal val nowStatus = MutableStateFlow(Status())
    internal val savingSchedule = MutableStateFlow(false)
    internal val nudge = MutableStateFlow<String?>(null)
    internal val nudgeStatus = MutableStateFlow(Status())
    internal val nudgeSaving = MutableStateFlow(false)
    internal val deviceStatus = MutableStateFlow(Status())

    internal val voiceSample by lazy { VoiceSamplePlayer(graph.context) { api.authHeaders() } }

    private val _tabRequests = MutableSharedFlow<AppTab>(extraBufferCapacity = 4)
    override val tabRequests: Flow<AppTab> = _tabRequests

    internal fun showTab(tab: AppTab) {
        _tabRequests.tryEmit(tab)
    }

    override fun relays(): List<String> = DEFAULT_RELAYS

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    /** The app is in the foreground (web: document.visibilityState === 'visible'). */
    private val foreground = MutableStateFlow(true)
    private var started = false
    private var bootJob: Job? = null
    /** Offline at start with the remembered ranking on screen: try again when back online or in view. */
    private var bootRetryPending = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val lifecycleObserver = LifecycleEventObserver { _, event ->
        when (event) {
            Lifecycle.Event.ON_START -> {
                foreground.value = true
                if (bootRetryPending && userNpub == null) boot()
                scope.launch { refreshDigests() }
            }
            Lifecycle.Event.ON_STOP -> foreground.value = false
            else -> Unit
        }
    }

    override fun start() {
        if (started) return
        started = true
        runCatching {
            ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
            foreground.value = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        }
        watchNetwork()
        boot()
    }

    override fun stop() {
        if (!started) return
        started = false
        runCatching { ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver) }
        networkCallback?.let { cb -> runCatching { graph.context.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } }
        networkCallback = null
        bootJob?.cancel()
        liveJob?.cancel()
        liveJob = null
        busyRetryJob?.cancel()
        stopJobTimers()
        voiceSample.stop()
    }

    private fun watchNetwork() {
        val cm = graph.context.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { if (bootRetryPending && userNpub == null && started) boot() }
            }
        }
        if (runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess) networkCallback = cb
    }

    init {
        // The right gate from the first frame: no session means the login, a session without a
        // remembered ranking means a short wait for the server.
        if (api.token == null) setGate(GateState.Login)
        else if (api.lastNpub == null) setGate(GateState.Booting)
    }

    private fun setGate(g: GateState) {
        gate.value = g
        _gateActive.value = g != GateState.None
    }

    // ─── Session state ───────────────────────────────────────────────────────

    /** The signed-in account (hex), confirmed by the server. */
    private var userNpub: String? = null
    /** Null until known; true while an account (confirmed or remembered) is on screen. */
    private var signedIn: Boolean? = null
    /** The identity whose remembered ranking and digests are on screen before the server confirms the session. */
    private var paintedNpub: String? = null

    private fun nowSec(): Long = System.currentTimeMillis() / 1000

    private fun hexOf(npub: String?): String? = npub?.let { Bech32.pubkeyHex(it) }

    private fun setIdentity(hex: String?) {
        if (_reader.value == hex) return
        _reader.value = hex
        graph.feedback.setIdentity(hex)
    }

    fun boot() {
        bootJob?.cancel()
        bootJob = scope.launch { bootInner() }
    }

    private suspend fun bootInner() {
        bootRetryPending = false
        startupError.value = ""
        if (gate.value == GateState.Startup) setGate(GateState.None)
        // No session on this device: the login gate, without asking the network.
        if (api.token == null) return showLogin()
        if (userNpub == null && signedIn != true && api.lastNpub == null) setGate(GateState.Booting)
        val remembered = scope.async { paintRemembered() }
        try {
            val me = api.me()
            onSignedIn(me.npub, me.entitlement)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val err = e.asApiError()
            if (err.status == 401) return showLogin()
            // Offline answers fast; what this device remembers decides between a quiet line and the error gate.
            remembered.await()
            val quiet = if (shownIds.isNotEmpty()) quietNotice(err.status, err.code) else null
            if (!quiet?.text.isNullOrEmpty()) {
                setQuietNotice(quiet.text)
                bootRetryPending = true
                return
            }
            if (signedIn != true) {
                startupError.value = "The server did not answer. Check your connection and try again; nothing has been ranked or charged here."
                setGate(GateState.Startup)
            } else {
                showFailure(err) { boot() }
            }
        }
    }

    /**
     * Before the server has answered: draw what this device remembers for the account last
     * signed in here, so a start is not blank. [onSignedIn] drops it if the session turns out
     * to be someone else's, and [showLogin] if there is no session.
     */
    private suspend fun paintRemembered() {
        val hex = hexOf(api.lastNpub) ?: return
        val snap = loadSnapshot(hex)
        val digests = loadHistory(hex)
        // The server may have answered meanwhile: its account and data win.
        if (signedIn == false || (userNpub != null && userNpub != hex)) return
        paintedNpub = hex
        if (userNpub == null) setIdentity(hex)
        if (!digestsKnown && digests.isNotEmpty()) setDigests(digests)
        if (snap == null || snap.posts.isEmpty() || shownIds.isNotEmpty()) return
        signedIn = true
        if (gate.value == GateState.Booting) setGate(GateState.None)
        drawFeed(snap.posts, snap.profiles, snap.hoursBack ?: 24, snap.fetched, snap.fresh)
        shownAt = snap.createdAt
        fetchedAt = snap.createdAt
        paintAge()
    }

    // ─── Login / logout ──────────────────────────────────────────────────────

    internal fun showLogin(message: String = "") {
        startupError.value = ""
        signedIn = false
        entitlement.value = null
        userNpub = null
        setIdentity(null)
        setGate(GateState.Login)
        notice.value = null
        paywall.value = false
        loadingText.value = null
        empty.value = null
        statusLine.value = null
        resetFeedState()
        _feed.value = FeedUiState()
        // Without a session, nothing remembered for any account stays on screen.
        if (paintedNpub != null || _digests.value.digests.isNotEmpty()) setDigests(emptyList())
        _digests.value = DigestListState()
        listState = ListState("")
        paintedNpub = null
        learnedText.value = ""
        firstRunHint.value = false
        loginStatus.value = Status(message, message.isNotEmpty())
    }

    /** Forget everything about the feed that is on screen. The stored copy is cleared by [signOut] only. */
    private fun resetFeedState() {
        liveJob?.cancel()
        liveJob = null
        busyRetryJob?.cancel()
        busyRetryJob = null
        shownIds = emptyList()
        baseKeys = emptyList()
        baseFresh = emptyList()
        shownAt = null
        fetchedAt = null
        pending = null
        pausedUntil = 0
        attemptFailed = false
        settingsChanged = false
        promptSet = false
        _feed.update { it.copy(pendingNewCount = 0, rankedAt = null, busyText = null, notice = null, loading = false) }
        stopJobTimers()
        job = DigestStatus.IDLE
        jobWasRunning = false
        readyDuringJob = null
        schedule.value = null
        // A run for the previous account is abandoned: its answer is dropped, and its busy state goes now.
        runEpoch++
        running = false
        runJob?.cancel()
        loadingText.value = null
        nudge.value = null
        digestsKnown = false
        _digests.update { it.copy(generation = null, makeStatus = null) }
    }

    /** The sign-in panel produced a signer: sign the server's challenge with it. The first login is the sign-up. */
    internal fun signIn(result: SignInResult) {
        if (signingIn.value) return
        signingIn.value = true
        loginStatus.value = Status()
        scope.launch {
            val signer = result.signer
            var adopted = false
            try {
                if (signer == null) {
                    loginStatus.value = Status(NPUB_LOGIN_UNAVAILABLE, true)
                    return@launch
                }
                loginStatus.value = Status("Waiting for your signer to sign the login…")
                api.loginWithSigner(signer, result.pubkey)
                val me = api.me()
                // The signer stays connected for replies, boosts, likes and zaps without another scan.
                graph.signers.remember(result)
                adopted = true
                loginStatus.value = Status()
                try {
                    onSignedIn(me.npub, me.entitlement)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    showFailure(e.asApiError()) { boot() }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                loginStatus.value = Status(describeError(e).message, true)
            } catch (e: Exception) {
                loginStatus.value = Status(e.message ?: "The sign-in did not complete. Try again.", true)
            } finally {
                // The signer connection was kept open only for this one signature.
                if (!adopted) runCatching { signer?.close() }
                signingIn.value = false
            }
        }
    }

    /** Log out: end the session, forget the signer and this account's data on this device. */
    fun signOut() {
        // The next account must not hear this one's digest.
        graph.audio.stop()
        scope.launch {
            graph.signers.forget()
            try {
                api.logout()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The session may already be gone; either way this device is done.
            }
            forgetAccountHere()
            showLogin()
        }
    }

    /** The next person on this device must not see this account's ranking or digests. */
    private suspend fun forgetAccountHere() {
        // After an offline start the remembered account is on screen without a verified session.
        val shown = userNpub ?: paintedNpub ?: hexOf(api.lastNpub)
        api.lastNpub = null
        api.forgetSession()
        if (shown != null) {
            runCatching {
                graph.records.delete(feedKey(shown))
                graph.records.delete(historyKey(shown))
            }
            prefs.edit().remove(draftKey(shown)).apply()
        }
        setDigests(emptyList())
    }

    /** Whether link cards are shown; set from the saved settings. */
    private var linkPreviewsOn = true
    private var loadedPrompt = ""
    private var loadedHours = 0

    private suspend fun onSignedIn(npub: String, ent: Entitlement) {
        val hex = hexOf(npub) ?: npub.lowercase()
        val switched = userNpub != hex
        // A remembered ranking or digest list from another account goes before anything of this one is drawn.
        if (paintedNpub != null && paintedNpub != hex) {
            resetShown()
            setDigests(emptyList())
        }
        paintedNpub = null
        userNpub = hex
        setIdentity(hex)
        signedIn = true
        setGate(GateState.None)
        notice.value = null
        setEntitlement(ent)
        paywalled = ent.state == "expired"
        api.lastNpub = npub

        val s = api.settings()
        if (userNpub != hex) return
        linkPreviewsOn = previewsEnabled(s.linkPreviews)
        form.update {
            it.copy(prompt = s.userPrompt, hours = s.hoursBack.toString(), topN = s.topN.toString(), learn = s.learnFromLikes, previews = linkPreviewsOn)
        }
        s.digestMinutes?.takeIf { it in DIGEST_MINUTES }?.let { m -> graph.deviceSettings.update { it.copy(digestMinutes = m) } }
        graph.feedback.adoptRules(s.feedback ?: emptyList())
        scope.launch {
            try {
                val l = api.learned()
                if (userNpub == hex) learnedText.value = l.prompt
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The learned taste is a nicety; the rest works without it.
            }
        }
        promptSet = s.userPrompt.isNotEmpty()
        loadedPrompt = s.userPrompt
        loadedHours = s.hoursBack
        loadDigestSection()
        if (userNpub != hex) return
        if (switched) restoreDraft(hex)
        // The list first, then the job status: a running digest's "what was there before" comes from the list.
        digestBoot = scope.launch {
            loadDigests()
            refreshDigestStatus()
        }

        if (!promptSet) return showFirstRun()
        firstRunHint.value = false
        startLiveChecks()
    }

    private fun resetShown() {
        shownIds = emptyList()
        baseKeys = emptyList()
        baseFresh = emptyList()
        shownAt = null
        fetchedAt = null
        pending = null
        _feed.value = FeedUiState()
    }

    /** No prompt yet: nothing runs until there is one. Say so where the person lands. */
    private fun showFirstRun() {
        liveJob?.cancel()
        liveJob = null
        firstRunHint.value = true
        empty.value = Empty(
            "Write what you care about, in your own words. As soon as you save it I rank your feed and write your first digest.",
            firstRun = true,
        )
        focusPromptField()
    }

    internal fun focusPromptField() {
        showTab(AppTab.Tune)
        focusPrompt.value++
    }

    private fun setEntitlement(ent: Entitlement) {
        entitlement.value = ent
    }

    // ─── Feed ────────────────────────────────────────────────────────────────

    private data class Pending(val posts: List<ScoredPost>, val profiles: Map<String, ProfileData>, val hoursBack: Int, val fetched: Int, val at: Long, val fresh: List<String>)

    private val _feed = MutableStateFlow(FeedUiState())
    private var running = false
    /** Bumped when the account changes: an answer for an older run belongs to someone else. */
    private var runEpoch = 0
    private var runJob: Job? = null
    private var liveJob: Job? = null
    private var busyRetryJob: Job? = null

    // `shownAt` is the run behind what is on screen; `fetchedAt` the newest run seen, which can be
    // ahead while the "N new notes" pill waits for a tap.
    private var shownIds: List<String> = emptyList()
    private var shownAt: Long? = null
    private var fetchedAt: Long? = null
    private var pending: Pending? = null
    // The ranking on screen as folded ids, and the notes it set apart as new.
    private var baseKeys: List<String> = emptyList()
    private var baseFresh: List<String> = emptyList()
    /** No automatic run before this time (unix seconds): after a daily cap or an outage. */
    private var pausedUntil = 0L
    /** An automatic run failed in a way that needs the reader; wait for a press. */
    private var attemptFailed = false
    /** The prompt or window changed since the stored ranking was made. */
    private var settingsChanged = false
    private var paywalled = false
    private var promptSet = false
    private var feedVisible = false
    private var atTop = true

    override val feed: FeedSource = object : FeedSource {
        override val state: StateFlow<FeedUiState> = _feed.asStateFlow()
        override fun refresh() {
            if (userNpub == null) return
            runFeed(manual = true)
        }
        override fun applyPending() = mergePending()
        override fun setVisible(visible: Boolean) {
            feedVisible = visible
            // Back from the payment tab: check now rather than at the next tick.
            if (visible && paying.value) payNudge.trySend(Unit)
        }
        override fun setAtTop(atTop: Boolean) {
            this@HostedController.atTop = atTop
        }
    }

    private fun setQuietNotice(text: String?) {
        _feed.update { it.copy(notice = text?.takeIf { t -> t.isNotEmpty() }) }
    }

    private fun paintAge() {
        _feed.update { it.copy(rankedAt = shownAt) }
    }

    /**
     * Look for work on open, whenever the app comes back to the foreground, and on a slow
     * timer while it is in view (web: startLiveChecks). A run itself is not tied to this
     * job, so going to the background never throws away a run that is already paid for.
     */
    private fun startLiveChecks() {
        liveJob?.cancel()
        liveJob = scope.launch {
            foreground.collectLatest { fg ->
                if (!fg) return@collectLatest
                while (true) {
                    liveCheck()
                    delay(CHECK_EVERY_MS)
                }
            }
        }
    }

    /** Whether the app may start a ranking by itself right now. */
    private fun autoDue(): Boolean = shouldAutoRun(
        ready = userNpub != null && promptSet && !paywalled,
        running = running,
        hidden = !foreground.value,
        createdAt = fetchedAt,
        nowSec = nowSec(),
        settingsChanged = settingsChanged,
        pausedUntil = pausedUntil,
        attemptFailed = attemptFailed,
    )

    /** Look at the server's stored ranking, then run in the background if what we have is stale. */
    private suspend fun liveCheck() {
        if (userNpub == null || !promptSet || running) return
        syncLatest()
        digestBoot?.join()
        if (autoDue()) runFeed() else maybeFirstDigest()
    }

    /** The stored ranking from the server. It never ranks and never uses the daily cap. */
    private suspend fun syncLatest() {
        val owner = userNpub ?: return
        try {
            val latest = api.latestFeed(fetchedAt)
            if (userNpub != owner) return
            settingsChanged = when (latest) {
                is LatestFeed.Unchanged -> latest.settingsChanged
                is LatestFeed.Snapshot -> latest.feed.settingsChanged
                null -> false
            }
            if (latest !is LatestFeed.Snapshot || (latest.feed.createdAt ?: 0) <= (fetchedAt ?: 0)) return
            setEntitlement(latest.feed.entitlement)
            applyFeed(latest.feed, manual = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val err = e.asApiError()
            if (err.status == 401 || err.status == 402) return showFailure(err) { scope.launch { syncLatest() } }
            val quiet = if (shownIds.isNotEmpty()) quietNotice(err.status, err.code) else null
            if (!quiet?.text.isNullOrEmpty()) setQuietNotice(quiet.text)
        }
    }

    /**
     * Take a ranking that arrived. The newest is always remembered on this device; whether
     * it replaces the list on screen depends on whether the reader is in the middle of it.
     */
    private fun applyFeed(feed: FeedResponse, manual: Boolean) {
        val at = feed.createdAt ?: nowSec()
        val incoming = feed.posts.map { it.id }
        val d = decideMerge(shownIds, incoming, atTop, feedVisible, manual)
        fetchedAt = max(fetchedAt ?: 0, at)
        val fresh = freshIds(baseKeys, foldedIds(feed.posts), baseFresh)
        rememberFeed(feed, at, fresh)
        setQuietNotice(null)
        when (d.action) {
            MergeAction.Pill -> {
                pending = Pending(feed.posts, feed.profiles, feed.hoursBack, feed.fetched, at, fresh)
                _feed.update { it.copy(pendingNewCount = d.newCount) }
            }
            MergeAction.Keep -> {
                if (d.same) shownAt = at
                paintAge()
            }
            else -> {
                pending = null
                _feed.update { it.copy(pendingNewCount = 0) }
                drawFeed(feed.posts, feed.profiles, feed.hoursBack, feed.fetched, fresh)
                shownAt = at
                paintAge()
            }
        }
    }

    private fun mergePending() {
        val p = pending ?: return
        pending = null
        _feed.update { it.copy(pendingNewCount = 0) }
        drawFeed(p.posts, p.profiles, p.hoursBack, p.fetched, p.fresh)
        shownAt = p.at
        paintAge()
    }

    private fun rememberFeed(feed: FeedResponse, at: Long, fresh: List<String>) {
        val owner = userNpub ?: return
        val snap = HostedSnapshot(createdAt = at, hoursBack = feed.hoursBack, fetched = feed.fetched, fresh = fresh, posts = feed.posts, profiles = feed.profiles)
        scope.launch { runCatching { graph.records.put(feedKey(owner), HostedSnapshot.serializer(), trimSnapshot(snap)) } }
    }

    /** Draw a ranking, [fresh] notes marked new. Also the only place that knows which posts are on screen. */
    private fun drawFeed(posts: List<ScoredPost>, profiles: Map<String, ProfileData>, hoursBack: Int, fetched: Int?, fresh: List<String>) {
        if (profiles.isNotEmpty()) graph.profiles.remember(profiles)
        if (posts.isEmpty()) {
            shownIds = emptyList()
            baseKeys = emptyList()
            baseFresh = emptyList()
            _feed.update { it.copy(posts = emptyList(), profiles = profiles, loading = false) }
            showEmpty("No posts from the people you follow in the last $hoursBack hours. Try a longer window in Tune.")
            statusLine.value = StatusLine.Text("No posts found")
            return
        }
        empty.value = null
        val folded = foldedIds(posts)
        val freshSet = fresh.toSet()
        baseKeys = folded
        baseFresh = folded.filter { it in freshSet }
        val marked = posts.map { p -> p.copy(isNew = foldedIds(listOf(p)).first() in freshSet) }
        _feed.update { it.copy(posts = marked, profiles = profiles, loading = false) }
        shownIds = posts.map { it.id }
        statusLine.value = StatusLine.Coverage(folded.size, max(fetched ?: 0, posts.size), hoursBack)
    }

    private fun showEmpty(text: String) {
        empty.value = Empty(text, firstRun = false)
    }

    internal fun runFeed(manual: Boolean = false): Job? {
        if (running || userNpub == null) return null
        running = true
        val epoch = runEpoch
        if (manual) {
            attemptFailed = false
            pausedUntil = 0
        }
        // Something readable is on screen: rank quietly beside it. Nothing yet: say what is happening.
        val quiet = shownIds.isNotEmpty()
        notice.value = null
        paywall.value = false
        empty.value = null
        busyRetryJob?.cancel()
        setQuietNotice(null)
        val job = scope.launch {
            // The feed request answers only when the ranking is done; meanwhile the server says where
            // the run is (fetching, waiting in line behind other readers, or ranking n of m).
            var progress: FeedProgress? = null
            val started = System.currentTimeMillis()
            val poll = launch {
                while (true) {
                    delay(2000)
                    if (!foreground.value || epoch != runEpoch) continue
                    try {
                        val p = api.feedProgress()
                        if (epoch == runEpoch) progress = p
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // Progress is a nicety; the run itself decides.
                    }
                }
            }
            val tick = launch {
                while (true) {
                    if (epoch == runEpoch) {
                        val text = describeProgress(progress, ((System.currentTimeMillis() - started) / 1000.0).roundToLong())
                        if (quiet) {
                            _feed.update { it.copy(busyText = if (progress is FeedProgress.Queued) text else "Ranking new posts…") }
                        } else {
                            loadingText.value = text
                            _feed.update { it.copy(loading = true) }
                        }
                    }
                    delay(1000)
                }
            }
            try {
                val feed = api.feed(100, manual)
                if (epoch != runEpoch) return@launch
                setEntitlement(feed.entitlement)
                paywalled = false
                pausedUntil = 0
                attemptFailed = false
                applyFeed(feed, manual)
                scope.launch { maybeFirstDigest() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (epoch == runEpoch) onRunFailed(e.asApiError(), quiet)
            } finally {
                poll.cancel()
                tick.cancel()
                // The account changed meanwhile: resetFeedState already reset the shared state.
                if (epoch == runEpoch) {
                    loadingText.value = null
                    _feed.update { it.copy(busyText = null, loading = false) }
                    running = false
                }
            }
        }
        runJob = job
        return job
    }

    private fun onRunFailed(err: ApiError, hadFeed: Boolean) {
        // A stored feed stays: a cap, an outage or no network get one quiet line, not an error card.
        val q = if (hadFeed) quietNotice(err.status, err.code) else null
        if (q != null) {
            pausedUntil = nowSec() + q.pauseSeconds
            if (q.text.isNotEmpty()) setQuietNotice(q.text)
            return
        }
        // Nothing on screen and the server is only busy: try again by itself, and say when.
        if (err.status == 503 && err.code == "busy") return retryWhenFree()
        // Nothing to fall back on, or it needs the reader: the normal affordance. No automatic second try.
        attemptFailed = true
        showFailure(err) { runFeed(manual = true) }
    }

    /** The first ranking met a full server: count down visibly, then try once more. */
    private fun retryWhenFree(seconds: Int = 30) {
        busyRetryJob?.cancel()
        val epoch = runEpoch
        val go = {
            busyRetryJob?.cancel()
            busyRetryJob = null
            notice.value = null
            if (epoch == runEpoch) runFeed(manual = true)
        }
        busyRetryJob = scope.launch {
            var left = seconds
            while (left > 0) {
                notice.value = Notice("The ranking service is busy with other readers. Trying again in ${left}s.", "Try now") { go() }
                delay(1000)
                if (epoch != runEpoch) return@launch
                left--
            }
            notice.value = null
            busyRetryJob = null
            runFeed(manual = true)
        }
    }

    /** Say what went wrong and offer the one thing that can fix it. */
    private fun showFailure(err: ApiError, retry: () -> Unit) {
        val d = describeError(err)
        statusLine.value = null
        when (d.action) {
            ErrorAction.Login -> showLogin(d.message)
            ErrorAction.Pay -> {
                paywalled = true
                setEntitlement(Entitlement("expired"))
                showPaywall(d.message)
            }
            ErrorAction.Settings -> notice.value = Notice(d.message, "Open Tune") { showTab(AppTab.Tune) }
            ErrorAction.Retry -> notice.value = Notice(d.message, "Try again") { retry() }
        }
    }

    // ─── Settings form ───────────────────────────────────────────────────────

    private var dirtyMain = false
    private var dirtySchedule = false

    /** A change in the Tune form. Kept as a draft for this account until its section is saved (web drafts.ts). */
    internal fun edit(schedulePart: Boolean, change: (TuneForm) -> TuneForm) {
        form.update(change)
        if (schedulePart) dirtySchedule = true else dirtyMain = true
        saveDraft()
        tuneStatus.value = Status("Unsaved preferences. Use the Save button for the section you changed.")
    }

    private fun draftKey(hex: String) = "tune_draft_$hex"

    @kotlinx.serialization.Serializable
    private data class Draft(val form: TuneForm, val main: Boolean, val schedule: Boolean)

    private fun saveDraft() {
        val owner = userNpub ?: return
        if (!dirtyMain && !dirtySchedule) {
            prefs.edit().remove(draftKey(owner)).apply()
            return
        }
        val text = AppJson.encodeToString(Draft.serializer(), Draft(form.value, dirtyMain, dirtySchedule))
        prefs.edit().putString(draftKey(owner), text).apply()
    }

    private fun restoreDraft(hex: String) {
        dirtyMain = false
        dirtySchedule = false
        val raw = prefs.getString(draftKey(hex), null) ?: return
        val d = runCatching { AppJson.decodeFromString(Draft.serializer(), raw) }.getOrNull() ?: return
        val f = d.form
        form.update {
            var n = it
            if (d.main) n = n.copy(prompt = f.prompt, hours = f.hours, topN = f.topN, learn = f.learn, previews = f.previews)
            if (d.schedule) n = n.copy(digestEnabled = f.digestEnabled, digestTime = f.digestTime, digestTz = f.digestTz, digestVoice = f.digestVoice, digestFormat = f.digestFormat)
            n
        }
        dirtyMain = d.main
        dirtySchedule = d.schedule
        if (d.main || d.schedule) tuneStatus.value = Status("Restored an unsaved draft. Save to apply it; Refresh uses saved settings.")
    }

    private fun sectionSaved(schedulePart: Boolean) {
        if (schedulePart) dirtySchedule = false else dirtyMain = false
        saveDraft()
        if (dirtyMain || dirtySchedule) tuneStatus.value = Status("This section is saved; changes in another section are still unsaved.")
    }

    internal fun saveSettingsForm() {
        if (saving.value) return
        val f = form.value
        val hours = parseWholeNumber(f.hours)
        val topN = parseWholeNumber(f.topN)
        val problem = validateHostedSettings(f.prompt, hours, topN)
        if (problem != null) {
            tuneStatus.value = Status(problem, true)
            return
        }
        // The server writes the digest, so the length choice goes there as well as to this device.
        val minutes = graph.deviceSettings.settings.value.digestMinutes.takeIf { it in DIGEST_MINUTES }
        saving.value = true
        tuneStatus.value = Status("Saving…")
        scope.launch {
            try {
                val saved = api.putSettings(buildJsonObject {
                    put("userPrompt", f.prompt.trim())
                    put("hoursBack", hours!!.toInt())
                    put("topN", topN!!.toInt())
                    put("learnFromLikes", f.learn)
                    put("linkPreviews", f.previews)
                    if (minutes != null) put("digestMinutes", minutes)
                })
                linkPreviewsOn = previewsEnabled(saved.linkPreviews)
                form.update { it.copy(prompt = saved.userPrompt) }
                tuneStatus.value = Status()
                sectionSaved(schedulePart = false)
                statusLine.value = StatusLine.Text("Settings saved")
                graph.toasts.show("Settings saved")
                notice.value = null
                afterSettingsSaved(saved.userPrompt, saved.hoursBack)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val err = e.asApiError()
                if (err.status == 401) showLogin(describeError(err).message)
                else tuneStatus.value = Status(describeError(err).message, true)
            } finally {
                saving.value = false
            }
        }
    }

    /**
     * A saved prompt starts the work. The first one lands the person on the Feed tab with
     * the ranking under way (and, once it is there, the first digest); a changed prompt or
     * window re-ranks quietly beside the stored feed.
     */
    private fun afterSettingsSaved(prompt: String, hoursBack: Int) {
        val first = !promptSet && prompt.isNotEmpty()
        val changed = prompt != loadedPrompt || hoursBack != loadedHours
        promptSet = prompt.isNotEmpty()
        loadedPrompt = prompt
        loadedHours = hoursBack
        firstRunHint.value = !promptSet
        if (!promptSet) {
            if (shownIds.isEmpty()) showFirstRun()
            return
        }
        if (first || changed) {
            settingsChanged = true
            attemptFailed = false
            pausedUntil = 0
        }
        if (first) {
            empty.value = null
            showTab(AppTab.Feed)
            startLiveChecks()
            return
        }
        if (changed) scope.launch { liveCheck() }
        else if (shownIds.isEmpty()) showEmpty("Press Refresh to rank your feed.")
    }

    internal fun resetLearned() {
        scope.launch {
            try {
                api.resetLearned()
                learnedText.value = ""
                learnedStatus.value = Status("Learned taste cleared. Only likes from now on will shape a new one.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                learnedStatus.value = Status(describeError(e).message, true)
            } catch (_: Exception) {
                learnedStatus.value = Status("Learned taste could not be reset. Check your connection.", true)
            }
        }
    }

    // ─── Payment ─────────────────────────────────────────────────────────────

    private var stopPaying = false
    private val payNudge = Channel<Unit>(Channel.CONFLATED)

    internal fun selectPlan(p: Plan) {
        plan.value = p
        satsText.value = p.sats.toString()
    }

    internal fun showPaywall(message: String = "") {
        showTab(AppTab.Feed)
        notice.value = null
        empty.value = null
        paywall.value = true
        payStatus.value = Status(message)
    }

    internal fun cancelPayment() {
        stopPaying = true
    }

    internal fun startPayment(context: Context) {
        if (paying.value) return
        val p = plan.value
        val sats = parseWholeNumber(satsText.value)
        val problem = validateSats(sats)
        if (problem != null) {
            payStatus.value = Status(problem, true)
            return
        }
        paying.value = true
        stopPaying = false
        val before = entitlement.value
        payStatus.value = Status("Creating the invoice…")
        scope.launch {
            try {
                val charge = try {
                    api.checkout(p, if (sats == p.sats) null else sats)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val err = e.asApiError()
                    if (err.status == 401) showLogin(describeError(err).message)
                    else payStatus.value = Status(describeError(err).message, true)
                    return@launch
                }
                val url = charge.checkoutUrl
                if (!isHttpUrl(url)) {
                    payStatus.value = Status("The payment page address was not valid. Try again.", true)
                    return@launch
                }
                payLink.value = url
                openPaymentPage(context, url!!)
                payStatus.value = Status("Waiting for your payment. Keep this page open.")
                val confirmed = waitForPayment(before)
                if (confirmed) {
                    payStatus.value = Status("Payment received. Thank you.")
                    paywall.value = false
                    runFeed()
                } else if (!stopPaying) {
                    payStatus.value = Status("The payment has not shown up yet. If you paid, it can take a few minutes: try Refresh again shortly.", true)
                } else {
                    payStatus.value = Status("Stopped waiting. If you paid, your access will update on the next Refresh.")
                }
            } finally {
                paying.value = false
                payLink.value = null
            }
        }
    }

    internal fun openPaymentPage(from: Context, url: String) {
        val uri = Uri.parse(url)
        // The invoice is created over the network first; the screen that asked may be gone by then (a fold, a rotation).
        val context = (from as? android.app.Activity)?.takeIf { !it.isFinishing && !it.isDestroyed } ?: graph.context
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().apply {
                if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }.launchUrl(context, uri)
        } catch (_: ActivityNotFoundException) {
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                    if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            }
        }
    }

    /** Poll `/me` until the payment shows up, the person stops, or ten minutes pass. */
    private suspend fun waitForPayment(before: Entitlement?): Boolean {
        val deadline = System.currentTimeMillis() + POLL_MAX_MS
        payNudge.tryReceive()
        while (!stopPaying && System.currentTimeMillis() < deadline) {
            withTimeoutOrNull(POLL_INTERVAL_MS) { payNudge.receive() }
            if (stopPaying) break
            try {
                val me = api.me()
                if (paymentConfirmed(before, me.entitlement)) {
                    setEntitlement(me.entitlement)
                    return true
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (e.status == 401) {
                    stopPaying = true
                    showLogin(describeError(e).message)
                    return false
                }
                // A blip while polling is not a failed payment; keep waiting.
            }
        }
        return false
    }

    // ─── Daily digest schedule ───────────────────────────────────────────────

    private var digestTz = ""

    private fun deviceZone(): String = runCatching { ZoneId.systemDefault().id }.getOrDefault("UTC")

    private suspend fun loadDigestSection() {
        scheduleStatus.value = Status()
        nowStatus.value = Status()
        try {
            val s = api.schedule()
            digestTz = defaultTimeZone(s.tz, s.enabled, deviceZone())
            form.update {
                it.copy(digestEnabled = s.enabled, digestTime = s.time, digestTz = digestTz, digestVoice = s.voice ?: "", digestFormat = s.dmFormat ?: "")
            }
            showScheduleInfo(s.copy(tz = digestTz))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val err = e.asApiError()
            if (err.status == 401) return showLogin(describeError(err).message)
            scheduleStatus.value = Status("The digest schedule could not be loaded.", true)
        }
    }

    private fun showScheduleInfo(s: Schedule) {
        schedule.value = s
        lastStatusLine.value = lastStatusText(s.lastStatus)
        scheduleStatus.value = Status(nextRunText(s))
        if (s.enabled) nudge.value = null
    }

    internal fun saveDigestSchedule() {
        if (savingSchedule.value) return
        val f = form.value
        val tz = f.digestTz.trim()
        val voice = f.digestVoice.ifEmpty { null }
        val format = f.digestFormat.ifEmpty { null }
        val problem = validateScheduleForm(f.digestTime, tz, voice)
        if (problem != null) {
            scheduleStatus.value = Status(problem, true)
            return
        }
        savingSchedule.value = true
        scheduleStatus.value = Status("Saving…")
        scope.launch {
            try {
                val saved = api.putSchedule(f.digestEnabled, f.digestTime, tz, voice, format, sendVoiceAndFormat = true)
                sectionSaved(schedulePart = true)
                digestTz = saved.tz
                showScheduleInfo(saved)
                val next = nextRunText(saved)
                scheduleStatus.value = Status(if (next.isNotEmpty()) "Saved. $next" else "Saved.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val err = e.asApiError()
                if (err.status == 401) showLogin(describeError(err).message)
                else scheduleStatus.value = Status(describeError(err).message, true)
            } finally {
                savingSchedule.value = false
            }
        }
    }

    private fun nudgeKey(hex: String) = "schedule_nudge_$hex"
    /** Offered at most once per app run (web: once per page load), and never again once answered. */
    private var nudgeOffered = false

    /** After the first real listen, once per account: offer daily delivery. It is never turned on without this press. */
    private fun maybeScheduleNudge() {
        val owner = userNpub ?: return
        val s = schedule.value ?: return
        if (s.enabled || nudgeOffered || prefs.contains(nudgeKey(owner))) return
        nudgeOffered = true
        val zone = if (isValidTimeZone(digestTz)) digestTz else deviceZone()
        nudgeStatus.value = Status()
        nudge.value = nudgeText(zone)
    }

    internal fun dismissScheduleNudge() {
        nudge.value = null
        userNpub?.let { prefs.edit().putString(nudgeKey(it), "dismissed").apply() }
    }

    internal fun acceptScheduleNudge() {
        if (nudgeSaving.value) return
        nudgeSaving.value = true
        nudgeStatus.value = Status("Saving…")
        scope.launch {
            try {
                val zone = if (isValidTimeZone(digestTz)) digestTz else deviceZone()
                val saved = api.putSchedule(enabled = true, time = NUDGE_TIME, tz = zone)
                digestTz = saved.tz
                form.update { it.copy(digestEnabled = true, digestTime = saved.time, digestTz = saved.tz) }
                showScheduleInfo(saved)
                dismissScheduleNudge()
                graph.toasts.show(scheduleLine(saved))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val err = e.asApiError()
                if (err.status == 401) showLogin(describeError(err).message)
                else nudgeStatus.value = Status(describeError(err).message, true)
            } finally {
                nudgeSaving.value = false
            }
        }
    }

    internal fun openScheduleSettings() = showTab(AppTab.Tune)

    // ─── Digests ─────────────────────────────────────────────────────────────

    private val _digests = MutableStateFlow(DigestListState())
    private var digestsKnown = false
    private var digestBoot: Job? = null

    /** The server's digest list as last read, with the answers' ETags, for one account. */
    private class ListState(val owner: String) {
        var list: List<DigestRecord>? = null
        var etag: String? = null
        var summaryEtag: String? = null
    }

    private var listState = ListState("")

    /** One read in flight at a time: triggers that coincide (tab shown, job poll, return to the app) share it. */
    private class ListRead(val owner: String, val summary: Boolean, val result: Deferred<List<DigestRecord>>)

    private var listRead: ListRead? = null
    private var lastListLoad = 0L

    private fun setDigests(list: List<DigestRecord>) {
        _digests.update { it.copy(digests = list, known = true) }
    }

    /**
     * Read the list from the server. A background read asks for the summary (no show notes) and
     * only with the ETag of the last answer, so an unchanged list is a body-less 304.
     */
    private suspend fun readServerList(owner: String, summary: Boolean): List<DigestRecord> {
        listRead?.let { r -> if (r.owner == owner && (r.summary == summary || !r.summary)) return r.result.await() }
        if (listState.owner != owner) listState = ListState(owner)
        val state = listState
        val result = CompletableDeferred<List<DigestRecord>>()
        val read = ListRead(owner, summary, result)
        listRead = read
        try {
            val answer = api.digests(DIGEST_FEED_LIMIT, summary, if (state.list != null) (if (summary) state.summaryEtag else state.etag) else null)
            val etag = when (answer) {
                is DigestList.Unchanged -> answer.etag
                is DigestList.Fresh -> answer.etag
            }
            if (summary) state.summaryEtag = etag else state.etag = etag
            val list = if (answer is DigestList.Unchanged && state.list != null) {
                state.list!!
            } else {
                val fresh = (answer as? DigestList.Fresh)?.digests ?: emptyList()
                // A list that omits the notes must not wipe notes already fetched.
                val known = (state.list ?: loadHistory(owner)).associateBy { it.id }
                fresh.map { d -> if (d.notes == null && known[d.id]?.notes != null) d.copy(notes = known[d.id]!!.notes) else d }
                    .also { state.list = it }
            }
            result.complete(list)
            return list
        } catch (e: Throwable) {
            result.completeExceptionally(e)
            throw e
        } finally {
            if (listRead === read) listRead = null
        }
    }

    /** What a redraw would change: order, audio and length; show notes load on their own. */
    private fun listShape(list: List<DigestRecord>): String = list.joinToString(",") { "${it.id}|${it.audioUrl ?: ""}|${it.durationSeconds ?: ""}" }

    /**
     * Newest digests from the server, cached so the tab opens offline. [quiet] is for
     * background refreshes: no spinner, no error card, the summary list only, and nothing
     * redrawn when nothing changed. Returns the list, or null when it could not be read.
     */
    private suspend fun loadDigests(quiet: Boolean = false): List<DigestRecord>? {
        val owner = userNpub ?: return null
        if (!quiet) _digests.update { it.copy(loading = true) }
        lastListLoad = System.currentTimeMillis()
        try {
            val before = if (listState.owner == owner) listState.list else null
            val list = readServerList(owner, quiet)
            // Signed out or another account meanwhile: this list is not theirs to see.
            if (userNpub != owner) return null
            if (list !== before) saveHistory(owner, list)
            digestsKnown = true
            if (!quiet || listShape(list) != listShape(_digests.value.digests)) setDigests(list)
            _digests.update { it.copy(error = null, known = true) }
            return list
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val err = e.asApiError()
            if (err.status == 401) {
                showLogin(describeError(err).message)
                return null
            }
            if (quiet || userNpub != owner) return null
            val cached = loadHistory(owner)
            if (cached.isNotEmpty() && _digests.value.digests.isEmpty()) setDigests(cached)
            _digests.update {
                it.copy(
                    known = true,
                    error = if (cached.isNotEmpty()) "Could not reach the server. Showing the digests saved on this device."
                    else "Your digests could not be loaded. Check your connection and try again.",
                )
            }
            return null
        } finally {
            if (!quiet) _digests.update { it.copy(loading = false) }
        }
    }

    /** Show notes fetched for one digest are kept with the list on this device, for offline reading. */
    private suspend fun loadFullDigest(d: DigestRecord): DigestRecord? {
        val owner = userNpub
        val full = try {
            api.digest(d.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401) showLogin(describeError(e).message)
            if (e.status == 404) return null
            throw e
        }
        if (full == null || owner == null || userNpub != owner) return full
        // The list here is the newest view: writing it back cannot drop a digest a list read just added.
        val current = listState.list
        if (listState.owner == owner && current != null) {
            val updated = current.map { x -> if (x.id == full.id) x.copy(notes = full.notes) else x }
            listState.list = updated
            saveHistory(owner, updated)
            _digests.update { s -> s.copy(digests = s.digests.map { x -> if (x.id == full.id) x.copy(notes = full.notes) else x }) }
            return full
        }
        val stored = loadHistory(owner)
        if (stored.any { it.id == full.id }) saveHistory(owner, stored.map { x -> if (x.id == full.id) x.copy(notes = full.notes) else x })
        return full
    }

    // ─── Digest on demand ────────────────────────────────────────────────────

    private var job = DigestStatus.IDLE
    private var jobWasRunning = false
    /** The digests the reader had when the run began, so a new one is recognised even from an empty list. */
    private var knownBeforeRun: List<String> = emptyList()
    private var jobPoll: Job? = null
    private var jobTick: Job? = null
    /** The digest of the running job that is already in the list while its DM is being sent. */
    private var readyDuringJob: String? = null
    private val askedThisRun = HashSet<String>()

    private class DigestRequestFailed(message: String) : Exception(message)

    private fun stopJobTimers() {
        jobPoll?.cancel()
        jobTick?.cancel()
        jobPoll = null
        jobTick = null
    }

    private fun digestIds(): List<String> = _digests.value.digests.map { it.id }

    private fun setMakeStatus(text: String?, isError: Boolean = false) {
        _digests.update { it.copy(makeStatus = text?.takeIf { t -> t.isNotEmpty() }, makeStatusIsError = isError) }
    }

    /** Both places that show the running digest: the Digests tab and the Tune line. */
    private fun paintJob() {
        val text = when {
            !job.running -> ""
            readyDuringJob != null -> arrivalText("ready")
            else -> progressText(job, nowSec())
        }
        if (job.running) {
            _digests.update { it.copy(generation = DigestGeneration(status = text, startedAt = job.startedAt), makeStatus = null) }
        }
        nowStatus.value = Status(text)
    }

    /** Read the server's view of the digest being written, and react to it starting or ending. */
    private suspend fun refreshDigestStatus() {
        val owner = userNpub ?: return
        try {
            val status = api.digestStatus()
            // Signed out or another account meanwhile: this job is not theirs.
            if (userNpub != owner) return
            if (status.running && readyDuringJob == null) {
                // The list can have the new digest before the job is finished (the DM is sent in between):
                // it can be played now, but delivery is only known once the job ends.
                val list = loadDigests(quiet = true)
                if (list != null && readyDuringRun(status, list)) {
                    val fresh = findArrived(knownBeforeRun, list) ?: list[0]
                    readyDuringJob = fresh.id
                    setDigests(list)
                }
            }
            applyDigestStatus(status)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401) showLogin(describeError(e).message)
            // A blip is not news; the next poll or visit looks again.
        } catch (_: Exception) {
        }
    }

    private fun applyDigestStatus(status: DigestStatus) {
        val step = nextJobStep(jobWasRunning, status)
        if (status.running && !jobWasRunning) knownBeforeRun = digestIds()
        job = status
        jobWasRunning = status.running

        if (status.running) {
            // Status every 10 s while the app is in view; in the background nothing is read, and it catches up on return.
            if (jobPoll == null) jobPoll = scope.launch {
                while (true) {
                    delay(JOB_POLL_MS)
                    if (foreground.value) refreshDigestStatus()
                }
            }
            if (jobTick == null) jobTick = scope.launch {
                while (true) {
                    delay(1000)
                    if (foreground.value) paintJob()
                }
            }
            paintJob()
            return
        }
        stopJobTimers()
        val shownEarly = readyDuringJob
        readyDuringJob = null
        _digests.update { it.copy(generation = null) }
        when (step) {
            is JobStep.Arrived -> scope.launch { announceArrival(step.dmPending, shownEarly) }
            is JobStep.Failed -> {
                setMakeStatus(step.message, true)
                nowStatus.value = Status(step.message, true)
                if (step.action == ErrorAction.Pay) {
                    setEntitlement(Entitlement("expired"))
                    paywalled = true
                    showPaywall(step.message)
                }
            }
            JobStep.None -> nowStatus.value = Status()
        }
    }

    /** The digest finished: load it and say so once where the reader is. */
    private suspend fun announceArrival(dmPending: Boolean, shownEarly: String?) {
        val list = loadDigests(quiet = true)
        if (shownEarly == null && list != null) setDigests(list)
        val text = arrivalText(if (dmPending) "dm_pending" else "sent")
        nowStatus.value = Status(text)
        setMakeStatus(text)
        if (feedVisible) graph.toasts.show(text)
    }

    /** Re-read the digest list and the job status: on opening the Digests tab and on returning to the app. */
    private suspend fun refreshDigests() {
        if (userNpub == null) return
        // Two triggers often fire together: one read is enough.
        if (System.currentTimeMillis() - lastListLoad < 3000) return
        loadDigests(quiet = true)
        refreshDigestStatus()
    }

    /** Ask the server for a digest now. Throws the text to show; anything that needs a screen of its own gets it. */
    private suspend fun requestDigest() {
        try {
            val (_, status) = api.digestNow()
            knownBeforeRun = digestIds()
            applyDigestStatus(status.copy(running = true, startedAt = status.startedAt ?: nowSec()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val err = e.asApiError()
            if (err.status == 409 && err.code == "digest_running") {
                // Another press, device or the schedule already started one: show that one.
                val startedAt = (err.data["startedAt"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: nowSec()
                knownBeforeRun = digestIds()
                applyDigestStatus(DigestStatus(running = true, startedAt = startedAt, lastDurationSeconds = job.lastDurationSeconds))
                return
            }
            val d = describeDigestNowError(err)
            when (d.action) {
                ErrorAction.Login -> showLogin(d.message)
                ErrorAction.Pay -> {
                    paywalled = true
                    setEntitlement(Entitlement("expired"))
                    showPaywall(d.message)
                }
                else -> throw DigestRequestFailed(d.message)
            }
        }
    }

    /**
     * The first digest, asked for once without a button: after the first ranking, for someone who has
     * none yet. The flag is written before the request, so a failure or a restart never asks twice.
     */
    private suspend fun maybeFirstDigest() {
        val owner = userNpub ?: return
        digestBoot?.join()
        val key = FIRST_DIGEST_KEY_PREFIX + owner
        val requested = owner in askedThisRun || prefs.contains(key)
        if (!shouldRequestFirstDigest(promptSet, shownIds.size, _digests.value.digests.size, digestsKnown, job.running, requested, paywalled)) return
        askedThisRun += owner
        prefs.edit().putLong(key, nowSec()).apply()
        try {
            requestDigest()
        } catch (e: DigestRequestFailed) {
            setMakeStatus(e.message, true)
        }
    }

    /** Tune's "Send me a digest now". */
    internal fun sendDigestNow() {
        // Double presses: nothing new starts while one is known to run.
        if (job.running) return
        nowStatus.value = Status("Asking for a digest…")
        scope.launch {
            try {
                requestDigest()
            } catch (e: DigestRequestFailed) {
                nowStatus.value = Status(e.message ?: "", true)
            }
        }
    }

    internal fun onListened() = maybeScheduleNudge()

    override val digests: DigestBackend = object : DigestBackend {
        override val mode = AppMode.Hosted
        override val state: StateFlow<DigestListState> = _digests.asStateFlow()
        override val makeLabel = "Send me a digest now"
        override val makeAnotherLabel = "Send me another digest now"
        override val emptyText =
            "I write a spoken digest of what the people you follow posted. It lands here and by Nostr DM. Turn on daily delivery in Tune to have one every morning. Nothing plays until you press play."

        override fun refresh() {
            scope.launch {
                if (_digests.value.error != null) {
                    loadDigests()
                    refreshDigestStatus()
                } else {
                    refreshDigests()
                }
            }
        }

        override fun make() {
            if (job.running || userNpub == null) return
            setMakeStatus("Asking for a digest…")
            scope.launch {
                try {
                    requestDigest()
                } catch (e: DigestRequestFailed) {
                    setMakeStatus(e.message, true)
                }
            }
        }

        override suspend fun loadFull(d: DigestRecord): DigestRecord? = withContext(Dispatchers.Main.immediate) { loadFullDigest(d) }

        /**
         * The public file the digest was uploaded to. The web plays that too and only
         * downloads through the server's proxy because a browser cannot read another
         * site (CORS); the app can, and the proxy is rate limited and buffers whole files.
         */
        override fun audioSource(d: DigestRecord): AudioSource? = safeAudioUrl(d.audioUrl)?.let { AudioSource.Remote(it) }

        override fun onListened(d: DigestRecord) = this@HostedController.onListened()
    }

    // ─── Feedback rules ──────────────────────────────────────────────────────

    private var feedbackJob: Job? = null

    /** Feedback rules wait a moment, so several taps make one request. A failure offers a retry. */
    override fun onFeedbackRulesChanged(rules: List<FeedbackRule>) {
        feedbackJob?.cancel()
        val owner = userNpub ?: return
        feedbackJob = scope.launch {
            delay(800)
            if (userNpub != owner) return@launch
            try {
                api.putFeedback(rules)
                if (userNpub == owner) graph.feedback.markRulesSynced(rules)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (userNpub != owner) return@launch
                val err = e.asApiError()
                if (err.status == 401) return@launch showLogin(describeError(err).message)
                graph.toasts.show(
                    "Your feedback is kept here but could not reach the server, so it does not steer rankings yet.",
                    "Retry",
                ) { onFeedbackRulesChanged(rules) }
            }
        }
    }

    // ─── Link previews ───────────────────────────────────────────────────────

    private val previewSlots = Semaphore(2)
    private val previewAnswers = object : LinkedHashMap<String, Deferred<LinkCard?>>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Deferred<LinkCard?>>?): Boolean = size > 256
    }

    /**
     * A card for [url] from the server's `/preview`, when the reader has previews on. Links that
     * would not get a card on the web (media, this server, credentials) get none here either;
     * callers show at most [MAX_CARDS_PER_POST] per note (see [extractPreviewUrls]).
     */
    override suspend fun linkPreview(url: String): LinkPreview? = withContext(Dispatchers.Main.immediate) { previewFor(url) }

    private suspend fun previewFor(url: String): LinkPreview? {
        if (!linkPreviewsOn || userNpub == null) return null
        val key = extractPreviewUrls(url, OWN_HOST, 1).firstOrNull() ?: return null
        val answer = previewAnswers[key] ?: scope.async { previewSlots.withPermit { api.preview(key) } }.also { previewAnswers[key] = it }
        val card = try {
            answer.await()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // A failure (offline, rate limited) is not remembered, so a later render can retry.
            if (previewAnswers[key] === answer) previewAnswers.remove(key)
            return null
        } ?: return null
        return LinkPreview(
            url = key,
            title = card.title.ifEmpty { null },
            description = card.description.ifEmpty { null },
            siteName = card.siteName.ifEmpty { null },
            imageUrl = card.image.ifEmpty { null }?.let(api::previewImageUrl),
            imageHeaders = if (card.image.isNotEmpty()) api.authHeaders() else emptyMap(),
        )
    }

    // ─── Account data ────────────────────────────────────────────────────────

    /** "Download my hosted data": the export, written to the file the reader picked. */
    internal fun exportAccount(context: Context, target: Uri) {
        deviceStatus.value = Status("Preparing your data…")
        scope.launch {
            try {
                val text = api.exportAccount()
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(target, "wt")?.use { it.write(text.toByteArray()) }
                        ?: throw java.io.IOException("no output")
                }
                deviceStatus.value = Status("Downloaded what the server keeps for your account.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                deviceStatus.value = Status(describeError(e).message, true)
            } catch (_: Exception) {
                deviceStatus.value = Status("The download failed. Check your connection.", true)
            }
        }
    }

    /** "Delete my hosted data", after the reader confirmed. Signs out and clears this account here. */
    internal suspend fun deleteAccount(): Boolean {
        try {
            api.deleteAccount()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            deviceStatus.value = Status(describeError(e).message, true)
            return false
        } catch (_: Exception) {
            deviceStatus.value = Status("Your data could not be deleted. Check your connection and try again.", true)
            return false
        }
        graph.signers.forget()
        forgetAccountHere()
        showLogin()
        return true
    }

    internal fun useOwnKey() {
        graph.modeStore.set(AppMode.Byok)
    }

    // ─── Device records ──────────────────────────────────────────────────────

    private fun feedKey(hex: String) = "feed:hosted:$hex"
    private fun historyKey(hex: String) = "history:hosted:$hex"

    private suspend fun loadSnapshot(hex: String): HostedSnapshot? =
        runCatching { graph.records.get(feedKey(hex), HostedSnapshot.serializer()) }.getOrNull()?.takeIf { it.v == 1 }

    private suspend fun loadHistory(hex: String): List<DigestRecord> =
        runCatching { graph.records.get(historyKey(hex), HISTORY) }.getOrNull() ?: emptyList()

    private fun saveHistory(hex: String, list: List<DigestRecord>) {
        scope.launch { runCatching { graph.records.put(historyKey(hex), HISTORY, list) } }
    }

    // ─── Mode controller UI ──────────────────────────────────────────────────

    @Composable
    override fun Gate(modifier: Modifier) = HostedGate(this, modifier)

    @Composable
    override fun FeedHeader(modifier: Modifier) = HostedFeedHeader(this, modifier)

    @Composable
    override fun DigestExtras(modifier: Modifier) = HostedDigestExtras(this, modifier)

    @Composable
    override fun Tune(modifier: Modifier) = HostedTune(this, modifier)

    companion object {
        /** The web's default relays: hosted mode has no relay setting of its own. */
        val DEFAULT_RELAYS = listOf("wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol")
        val DIGEST_MINUTES = setOf(3, 6, 10)
        private const val POLL_INTERVAL_MS = 4000L
        private const val POLL_MAX_MS = 10 * 60 * 1000L
        /** How often the job status is read while a digest is being written. */
        private const val JOB_POLL_MS = 10_000L
        /** The digest list asked for, per request. */
        private const val DIGEST_FEED_LIMIT = 30
        private const val FIRST_DIGEST_KEY_PREFIX = "first_digest_"
        private val HISTORY = ListSerializer(DigestRecord.serializer())
        /** The app's own server: links to it get no preview card. */
        val OWN_HOST: String = runCatching { URI(today.cypherpunk.nalgorithm.BuildConfig.HOSTED_BASE).host ?: "" }.getOrDefault("")

        const val NPUB_LOGIN_UNAVAILABLE =
            "Pasting an npub is not available here. Hosted mode keeps your settings and subscription under your key, so the server needs a signature to know it is really you. To only look at a feed without signing anything, use bring-your-own-key mode."
    }
}

internal fun Exception.asApiError(): ApiError = this as? ApiError ?: ApiError(0, message ?: "Network error", "network")
