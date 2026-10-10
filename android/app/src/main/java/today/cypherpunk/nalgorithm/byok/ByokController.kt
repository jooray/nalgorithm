package today.cypherpunk.nalgorithm.byok

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.engine.ChatMessage
import today.cypherpunk.nalgorithm.engine.DebugEntry
import today.cypherpunk.nalgorithm.engine.DigestWriter
import today.cypherpunk.nalgorithm.engine.Feedback
import today.cypherpunk.nalgorithm.engine.FetchedPost
import today.cypherpunk.nalgorithm.engine.Fetcher
import today.cypherpunk.nalgorithm.engine.LlmConfig
import today.cypherpunk.nalgorithm.engine.Pubkeys
import today.cypherpunk.nalgorithm.engine.Ranker
import today.cypherpunk.nalgorithm.engine.RankerConfig
import today.cypherpunk.nalgorithm.engine.ScoreOptions
import today.cypherpunk.nalgorithm.engine.ScorerKind
import today.cypherpunk.nalgorithm.engine.Scoring
import today.cypherpunk.nalgorithm.engine.Tts
import today.cypherpunk.nalgorithm.engine.chatCompletion
import today.cypherpunk.nalgorithm.engine.scored
import kotlinx.coroutines.flow.Flow
import today.cypherpunk.nalgorithm.mode.AppTab
import today.cypherpunk.nalgorithm.mode.AudioSource
import today.cypherpunk.nalgorithm.mode.DigestBackend
import today.cypherpunk.nalgorithm.mode.DigestGeneration
import today.cypherpunk.nalgorithm.mode.DigestListState
import today.cypherpunk.nalgorithm.mode.FeedSource
import today.cypherpunk.nalgorithm.mode.FeedUiState
import today.cypherpunk.nalgorithm.mode.ModeController
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.io.File

/**
 * Bring-your-own-key mode: everything runs on this phone (web app.ts, ui.ts,
 * byok-digest.ts). A run reads follows, then their posts, scores what the cache
 * has not seen, loads profiles, and learns from likes in the background.
 *
 * Navigation goes through [tabRequests].
 */
class ByokController(private val graph: AppGraph) : ModeController {
    override val mode = AppMode.Byok

    internal val store = ByokSettingsStore(graph.context)
    val settings: StateFlow<ByokSettings> = store.settings
    private val scores = ScoreCache(graph.records)
    private val learning = Learning(graph.records, graph.http)
    internal val local = LocalData(graph.records)

    private val _reader = MutableStateFlow(store.settings.value.identityHex)
    override val reader: StateFlow<String?> = _reader.asStateFlow()

    override fun relays(): List<String> = settings.value.relays

    private val _tabs = MutableSharedFlow<AppTab>(extraBufferCapacity = 4)
    /** "Finish setup" and the first run ask for Tune; the first save asks for the Feed. */
    override val tabRequests: Flow<AppTab> = _tabs.asSharedFlow()

    private val _learned = MutableStateFlow("")
    /** The learned taste of the configured identity ("" when none). */
    val learnedPrompt: StateFlow<String> = _learned.asStateFlow()

    private val _running = MutableStateFlow(false)
    /** A feed run or a learned-taste update is going; Refresh waits. */
    val running: StateFlow<Boolean> = _running.asStateFlow()

    // ─── Tune state (kept here so it survives leaving the tab) ──────────────

    /** The form being edited; null until Tune is first shown. */
    internal var draft by mutableStateOf<ByokSettings?>(null)
    internal var tuneStatus by mutableStateOf<Pair<String, Boolean>?>(null)
    internal var catalogStatus by mutableStateOf("")
    internal var catalog by mutableStateOf<List<ModelInfo>>(emptyList())
    internal var showAllSettings by mutableStateOf(false)
    internal var learnStatus by mutableStateOf<String?>(null)
    internal var resetStatus by mutableStateOf<String?>(null)
    /** The essential the setup steps point at, focused when Tune opens. */
    internal var focusField by mutableStateOf<SetupField?>(null)

    // ─── Feed state (web app.ts) ─────────────────────────────────────────────

    /** What the empty feed says; null hides it (web showEmptyState). */
    internal data class EmptyCard(val configured: Boolean, val message: String? = null)

    internal val emptyCard = MutableStateFlow<EmptyCard?>(null)
    private val _feed = MutableStateFlow(FeedUiState())
    private var currentPosts: List<ScoredPost> = emptyList()
    private var currentProfiles: Map<String, ProfileData> = emptyMap()
    private var shownIds: List<String> = emptyList()
    private var shownAt: Long? = null
    private var fetchedAt: Long? = null
    private var pending: Pair<List<ScoredPost>, Long>? = null
    /** No automatic run before this time (unix seconds) after a failed one. */
    private var pausedUntil = 0L
    /** The settings the ranking on screen was made with. */
    private var rankedSig: String? = null
    private var baseKeys: List<String> = emptyList()
    private var baseFresh: List<String> = emptyList()
    private var shownFresh: List<String> = emptyList()
    private var coverage: String? = null
    private var quietNotice: String? = null
    private var isRunning = false
    private var feedVisible = false
    private var atTop = true
    private var identityKnown = false
    private var shownIdentity: String? = null

    private var started = false
    private var runJob: Job? = null
    private var ticker: Job? = null
    private val foreground = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) = autoCheck()
    }

    private fun nowSec() = System.currentTimeMillis() / 1000
    private fun sigOf(s: ByokSettings) = "${s.npub.trim()}|${s.hoursBack}|${s.userPrompt}"
    private fun hidden() = !ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun paintFeed() {
        _feed.update {
            it.copy(
                posts = currentPosts,
                profiles = currentProfiles,
                rankedAt = shownAt,
                fresh = shownFresh,
                notice = quietNotice ?: coverage,
                pendingNewCount = pending?.let { (posts, _) -> SnapshotLogic.countNew(shownIds, posts.map { p -> p.id }) } ?: 0,
            )
        }
    }

    private fun coverageOf(posts: List<ScoredPost>, s: ByokSettings): String = SnapshotLogic.coverageText(
        shown = SnapshotLogic.foldedIds(posts).size,
        ranked = posts.size,
        hoursBack = s.hoursBack,
        order = graph.deviceSettings.settings.value.feedOrder,
        unranked = posts.count { it.defaultScore },
    )

    /** Draw the ranking as it stands; called as each batch lands, so results build up. */
    private fun renderCurrent() {
        shownIds = currentPosts.map { it.id }
        shownFresh = SnapshotLogic.freshIds(baseKeys, SnapshotLogic.foldedIds(currentPosts), baseFresh)
        if (currentPosts.isNotEmpty()) emptyCard.value = null
        paintFeed()
    }

    /** What is on screen is a finished ranking: the next one is compared with it. */
    private fun commitShown() {
        baseKeys = SnapshotLogic.foldedIds(currentPosts)
        baseFresh = shownFresh
    }

    private fun saveFeed(posts: List<ScoredPost>, at: Long, s: ByokSettings, fresh: List<String>) {
        val hex = s.identityHex ?: return
        val snap = FeedSnapshot(createdAt = at, hoursBack = s.hoursBack, sig = sigOf(s), fresh = fresh, posts = posts, profiles = currentProfiles)
        graph.scope.launch(Dispatchers.Default) { runCatching { local.saveFeedSnapshot(hex, snap) } }
    }

    /** Draw the feed this device remembers, before any network call. True when there was one. */
    private suspend fun showStoredFeed(s: ByokSettings): Boolean {
        val hex = s.identityHex ?: return false
        val snap = withContext(Dispatchers.Default) { runCatching { local.loadFeedSnapshot(hex) }.getOrNull() }
        // A run that finished first, or a different identity saved meanwhile, wins.
        if (snap == null || snap.posts.isEmpty() || currentPosts.isNotEmpty() || settings.value.identityHex != hex) return false
        currentPosts = snap.posts
        currentProfiles = snap.profiles
        graph.profiles.remember(snap.profiles)
        baseKeys = SnapshotLogic.foldedIds(currentPosts)
        baseFresh = snap.fresh
        shownAt = snap.createdAt
        fetchedAt = snap.createdAt
        rankedSig = snap.sig
        coverage = coverageOf(currentPosts, s)
        renderCurrent()
        return true
    }

    /** Another identity in Tune: nothing of the previous one stays on screen. */
    private suspend fun followIdentity(s: ByokSettings) {
        val next = s.identityHex
        // A run in flight finishes for its own identity, then calls this again.
        if ((identityKnown && next == shownIdentity) || isRunning) return
        val first = !identityKnown
        identityKnown = true
        shownIdentity = next
        _reader.value = next
        graph.feedback.setIdentity(next)
        currentPosts = emptyList()
        currentProfiles = emptyMap()
        shownIds = emptyList(); baseKeys = emptyList(); baseFresh = emptyList(); shownFresh = emptyList()
        shownAt = null; fetchedAt = null; pending = null; rankedSig = null
        coverage = null; quietNotice = null
        _feed.value = FeedUiState()
        emptyCard.value = null
        _learned.value = runCatching { learning.prompt(s) }.getOrDefault("")
        loadDigests(next)
        // Two quick saves: only the newest identity may land.
        if (settings.value.identityHex != next) return
        val stored = showStoredFeed(s)
        if (!stored) {
            if (SettingsValidation.validate(s) != null) emptyCard.value = EmptyCard(configured = false)
            else if (!s.autoRefresh) emptyCard.value = EmptyCard(configured = true)
        }
        // The startup caller runs the first check itself; a later switch ranks the new identity now.
        if (!first) autoCheck()
    }

    /** Take a finished ranking: always remembered; it replaces the list unless the reader is in it. */
    private fun applyRanking(posts: List<ScoredPost>, s: ByokSettings, manual: Boolean) {
        val at = nowSec()
        fetchedAt = at
        // A new prompt or window is a different feed, not a newer one: nothing to set apart.
        if (rankedSig != null && rankedSig != sigOf(s)) { baseKeys = emptyList(); baseFresh = emptyList() }
        rankedSig = sigOf(s)
        saveFeed(posts, at, s, SnapshotLogic.freshIds(baseKeys, SnapshotLogic.foldedIds(posts), baseFresh))
        val d = SnapshotLogic.decideMerge(shownIds, posts.map { it.id }, readerMidList = feedVisible && !atTop, manual = manual)
        when (d.action) {
            SnapshotLogic.MergeAction.Pill -> {
                pending = posts to at
                paintFeed()
                return
            }
            SnapshotLogic.MergeAction.Keep -> {
                if (d.same) shownAt = at
                paintFeed()
                return
            }
            else -> Unit
        }
        pending = null
        currentPosts = posts
        renderCurrent()
        commitShown()
        shownAt = at
        coverage = coverageOf(posts, s)
        paintFeed()
    }

    private fun mergePending() {
        val (posts, at) = pending ?: return
        pending = null
        currentPosts = posts
        renderCurrent()
        commitShown()
        shownAt = at
        coverage = coverageOf(posts, settings.value)
        paintFeed()
    }

    /** Open, back in the app, every five minutes: rank quietly when the stored feed is stale. */
    fun autoCheck() {
        if (!started) return
        val s = settings.value
        val due = SnapshotLogic.shouldAutoRun(
            SnapshotLogic.AutoRunInput(
                enabled = s.autoRefresh,
                ready = SettingsValidation.validate(s) == null,
                running = isRunning,
                hidden = hidden(),
                createdAt = fetchedAt,
                nowSec = nowSec(),
                settingsChanged = rankedSig != null && rankedSig != sigOf(s),
                pausedUntil = pausedUntil,
            ),
        )
        if (due) launchRun(auto = true)
    }

    private fun launchRun(auto: Boolean) {
        if (isRunning) return
        runJob = graph.scope.launch {
            try {
                runFeed(auto)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _feed.update { it.copy(error = "Error: ${e.message}") }
            }
        }
    }

    // ─── The run (web app.ts runFeed) ────────────────────────────────────────

    private suspend fun runFeed(auto: Boolean) {
        if (isRunning) return
        val s = settings.value
        SettingsValidation.validate(s)?.let { error ->
            _feed.update { it.copy(error = "Config error: $error") }
            return
        }

        // A run the reader did not ask for, beside a feed they can read: it works in the
        // background and never redraws the list itself (see applyRanking).
        val quiet = auto && currentPosts.isNotEmpty()
        if (!auto) pausedUntil = 0
        fun progress(text: String, fraction: Float? = null) {
            if (!quiet) _feed.update { it.copy(busyText = text, progress = fraction) }
        }
        /** A problem: a quiet run leaves the stored feed alone and says so in one line. */
        fun report(text: String) {
            if (quiet) {
                pausedUntil = nowSec() + 300
                quietNotice = "$text. Showing your last ranking."
                paintFeed()
            } else {
                _feed.update { it.copy(error = text) }
                if (currentPosts.isEmpty()) emptyCard.value = EmptyCard(configured = false, message = "$text. Open Tune to check your identity, model and relays.")
            }
        }
        /** False once Tune names another identity: this run's results then only go to its own storage. */
        fun stillMine() = settings.value.identityHex == s.identityHex
        fun setWorking(list: List<ScoredPost>) {
            if (!quiet && stillMine()) {
                currentPosts = list
                renderCurrent()
            }
        }

        isRunning = true
        _running.value = true
        quietNotice = null
        _feed.update { it.copy(error = null, notice = coverage, busyText = if (quiet) "Ranking new posts…" else null, progress = null, loading = currentPosts.isEmpty()) }
        if (currentPosts.isEmpty()) emptyCard.value = EmptyCard(configured = true, message = "Loading and ranking your feed. The line above shows progress.")

        try {
            val pubkeyHex = s.identityHex ?: run {
                _feed.update { it.copy(error = "Invalid npub or pubkey") }
                return
            }
            val fetcher = Fetcher(graph.relayPool, s.relays)

            progress("Fetching follow list...")
            val follows = try {
                fetcher.getFollows(pubkeyHex)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                report("Failed to fetch follows: ${e.message}")
                return
            }
            if (follows.isEmpty()) {
                report("No follows found for this pubkey")
                return
            }

            progress("Found ${follows.size} follows. Fetching posts...")
            val posts = try {
                fetcher.getPosts(follows, hoursBack = s.hoursBack)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                report("Failed to fetch posts: ${e.message}")
                return
            }
            if (posts.isEmpty()) {
                report("No posts found in the time window")
                if (!quiet) emptyCard.value = EmptyCard(configured = true, message = "No posts from the people you follow in the last ${s.hoursBack} hours. Try a longer window in Tune.")
                return
            }

            progress("Fetched ${posts.size} posts. Loading profiles...")
            val allPubkeys = Pubkeys.ofFetched(posts)
            val known = graph.profiles.profiles.value
            currentProfiles = allPubkeys.mapNotNull { pk -> known[pk]?.let { pk to it } }.toMap()
            graph.scope.launch {
                try {
                    val found = fetcher.getProfiles(allPubkeys)
                    graph.profiles.remember(found)
                    if (sigOf(settings.value) != sigOf(s)) return@launch
                    currentProfiles = currentProfiles + found
                    if (currentPosts.isNotEmpty() && !quiet) paintFeed()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Profile enrichment unavailable: names stay as npubs.
                }
            }

            // Private more/less feedback is explicit, so it steers even with learning off.
            val learnedPrompt = Feedback.withFeedback(if (s.learnFromLikes) _learned.value.ifEmpty { null } else null, graph.feedback.rules())

            runCatching { scores.prune() }
            val scoreCache = scores.load(s)
            val cachedPosts = mutableListOf<ScoredPost>()
            val uncachedPosts = mutableListOf<FetchedPost>()
            for (p in posts) {
                // Keyed by the boosted event, so a boost of something already scored is a hit.
                val hit = scoreCache[Scoring.scoreCacheKey(p)]
                // A score from the other scorer sits on a different scale.
                if (hit != null && (hit.scorer ?: "chat") == s.scorer) cachedPosts.add(p.scored(hit.score, hit.justification)) else uncachedPosts.add(p)
            }

            // With a warm cache the feed appears at once; new scores slot in as they arrive.
            if (cachedPosts.isNotEmpty()) setWorking(cachedPosts.sortedByDescending { it.score })

            var newlyScored: List<ScoredPost> = emptyList()
            if (uncachedPosts.isNotEmpty()) {
                progress("Scoring ${uncachedPosts.size} new posts (${cachedPosts.size} cached)...", 0f)
                val decision = s.scorer == "decision"
                val landed = mutableListOf<ScoredPost>()
                try {
                    val ranker = Ranker(
                        RankerConfig(
                            llm = LlmConfig(s.apiBaseUrl, s.apiKey, s.scoringModel, http = graph.http),
                            batchSize = s.batchSize,
                            concurrency = s.concurrency,
                            scorer = ScorerKind.of(s.scorer),
                        ),
                    )
                    val debug = mutableListOf<DebugEntry>()
                    newlyScored = ranker.score(
                        uncachedPosts,
                        ScoreOptions(
                            userPrompt = s.userPrompt,
                            learnedPrompt = learnedPrompt,
                            profiles = currentProfiles,
                            debug = debug,
                            onProgress = { n, total ->
                                progress("Scoring posts $n/$total (${cachedPosts.size} cached)...", if (total > 0) n.toFloat() / total else null)
                            },
                            // Each batch is kept the moment it lands: a closed app keeps what was paid for.
                            onBatchScored = { batch ->
                                val real = batch.filter { !it.defaultScore }
                                if (real.isNotEmpty()) {
                                    val entries = real.associate { Scoring.scoreCacheKey(it) to ScoreEntry(it.score, it.justification, if (decision) "decision" else null) }
                                    graph.scope.launch { runCatching { scores.put(s, entries) } }
                                }
                                landed.addAll(batch)
                                setWorking((cachedPosts + landed).sortedByDescending { it.score })
                            },
                        ),
                    )
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    report("Scoring failed: ${e.message}")
                    return
                }
            }

            val allScored = (cachedPosts + newlyScored).sortedByDescending { it.score }
            if (!stillMine()) {
                saveFeed(allScored, nowSec(), s, emptyList())
                return
            }
            applyRanking(allScored, s, manual = !auto)
            val cachedLabel = if (cachedPosts.isNotEmpty()) " ${cachedPosts.size} scores came from this device's cache." else ""
            if (!quiet && pending == null) {
                coverage = coverageOf(allScored, s) + cachedLabel
                paintFeed()
            }

            // Phase 2, in the background: likes → learned taste for future runs (no re-scoring).
            if (s.learnFromLikes) {
                graph.scope.launch {
                    try {
                        val prompt = learning.learnIncrementally(graph.scope, Fetcher(graph.relayPool, s.relays), s).await()
                        if (!prompt.isNullOrEmpty() && activeLearningResult(s)) _learned.value = prompt
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // The reader already has their ranked feed; learning tries again next run.
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report("Error: ${e.message}")
        } finally {
            isRunning = false
            _running.value = false
            _feed.update { it.copy(busyText = null, progress = null, loading = false) }
            if (currentPosts.isNotEmpty()) emptyCard.value = null
            else if (emptyCard.value?.message == "Loading and ranking your feed. The line above shows progress.") {
                emptyCard.value = if (SettingsValidation.validate(settings.value) != null) EmptyCard(false) else EmptyCard(true)
            }
            if (!stillMine()) graph.scope.launch { followIdentity(settings.value) }
        }
    }

    private fun activeLearningResult(s: ByokSettings): Boolean {
        val current = settings.value
        return current.learnFromLikes && current.identityHex == s.identityHex
    }

    // ─── Feed source ─────────────────────────────────────────────────────────

    override val feed: FeedSource = object : FeedSource {
        override val state: StateFlow<FeedUiState> = _feed.asStateFlow()

        override fun refresh() = launchRun(auto = false)

        override fun applyPending() = mergePending()

        override fun setVisible(visible: Boolean) {
            feedVisible = visible
            if (visible) autoCheck()
        }

        override fun setAtTop(atTop: Boolean) {
            this@ByokController.atTop = atTop
        }
    }

    // ─── Digests (web byok-digest.ts) ────────────────────────────────────────

    private val _digests = MutableStateFlow(DigestListState())

    private suspend fun loadDigests(hex: String?) {
        if (hex == null) {
            _digests.update { it.copy(digests = emptyList(), known = true, loading = false) }
            return
        }
        val list = runCatching { local.loadDigestHistory(hex) }.getOrDefault(emptyList())
        if (settings.value.identityHex != hex) return
        // Snapshots render the notes offline; fresher profiles are never overwritten.
        val known = graph.profiles.profiles.value
        val snaps = list.flatMap { d -> d.profiles.orEmpty().entries }
            .filter { (pk, _) -> pk !in known }
            .associate { (pk, p) -> pk to ProfileData(pk, p.name, p.picture, p.nip05) }
        if (snaps.isNotEmpty()) graph.profiles.remember(snaps)
        _digests.update { it.copy(digests = list, known = true, loading = false, error = null) }
    }

    private fun audioDir() = File(graph.context.filesDir, "byok-audio")
    private fun audioFile(d: DigestRecord) = File(audioDir(), d.id.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".mp3")

    /** The posts a digest is written from: what is on screen, or a fresh run first from a cold start. */
    private suspend fun ensureFeed(s: ByokSettings): Pair<List<ScoredPost>, Map<String, ProfileData>> {
        SettingsValidation.validate(s)?.let { throw Exception("$it. Open Tune to finish setting up.") }
        // Mid-switch, the notes on screen may still be the previous identity's.
        if (shownIdentity != s.identityHex) throw Exception("Switching to the identity in Tune. Try again once its feed is on screen.")
        if (currentPosts.isEmpty()) {
            _digests.update { it.copy(generation = DigestGeneration(status = "Loading your feed first…", startedAt = nowSec())) }
            runJob?.takeIf { it.isActive }?.join()
            if (currentPosts.isEmpty()) runFeed(auto = false)
        }
        if (currentPosts.isEmpty()) throw Exception(_feed.value.error ?: "No posts to write from yet.")
        return currentPosts to currentProfiles
    }

    /**
     * Write a digest from these posts. Reasoning models buffer before emitting anything, so
     * the status runs on its own clock: during the quiet stretch, elapsed seconds are the only
     * signal separating "thinking" from "hung".
     */
    private suspend fun writeDigest(posts: List<ScoredPost>, profiles: Map<String, ProfileData>, s: ByokSettings): String {
        if (posts.isEmpty()) throw Exception("Nothing to summarize yet. Refresh your feed first.")
        val model = s.digestModel.trim().ifEmpty { s.model }
        val lock = Any()
        val streamed = StringBuilder()
        val startedAtMs = System.currentTimeMillis()
        fun paint() {
            val text = synchronized(lock) { streamed.toString() }
            val seconds = (System.currentTimeMillis() - startedAtMs + 500) / 1000
            val progress = if (text.isNotEmpty()) "${seconds}s, ${LocalDigests.wordCount(text)} words" else "${seconds}s, thinking"
            _digests.update { it.copy(generation = DigestGeneration(text = text, status = "Writing your digest with $model ($progress)…", startedAt = startedAtMs / 1000)) }
        }
        paint()
        val tick = graph.scope.launch {
            while (isActive) {
                delay(500)
                paint()
            }
        }
        var failure: String? = null
        val text = try {
            DigestWriter.generateDigest(
                LlmConfig(s.apiBaseUrl, s.apiKey, model, http = graph.http),
                DigestWriter.Options(
                    posts = posts,
                    profiles = profiles,
                    userPrompt = s.userPrompt,
                    // Learning off means learned taste is ignored, here as in ranking.
                    learnedPrompt = if (s.learnFromLikes) _learned.value.ifEmpty { null } else null,
                    topN = s.digestTopN,
                    targetMinutes = graph.deviceSettings.settings.value.digestMinutes,
                    forSpeech = s.digestForSpeech,
                    onDelta = { piece -> synchronized(lock) { streamed.append(piece) } },
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message ?: "unknown error"
            // Whatever streamed in before the failure is real text; it is kept.
            synchronized(lock) { streamed.toString() }
        } finally {
            tick.cancel()
        }
        if (text.isBlank()) throw Exception("Digest failed: ${failure ?: "the model returned nothing"}")

        val record = LocalDigests.makeLocalDigest(text, posts, s.digestTopN, profiles)
        val hex = s.identityHex ?: throw Exception("Invalid npub or pubkey")
        val kept = local.addDigest(hex, record)
        // Written for the identity that asked; if Tune names another now, it waits in that history.
        if (settings.value.identityHex == hex) {
            _digests.update { it.copy(digests = LocalData.withDigest(it.digests, record)) }
        }
        val words = LocalDigests.wordCount(record.text)
        val unsaved = if (kept) "" else " This device could not save it, so it stays only until you close the app."
        return if (failure != null) {
            "Digest failed part-way ($failure). Kept the $words words that arrived."
        } else {
            "Digest ready: ${record.notes?.size ?: 0} notes, $words words, $model.$unsaved"
        }
    }

    override val digests: DigestBackend = object : DigestBackend {
        override val mode = AppMode.Byok
        override val state: StateFlow<DigestListState> = _digests.asStateFlow()
        override val makeLabel = "Write a digest"
        override val makeAnotherLabel = "Write another digest"
        override val emptyText = "I write a spoken digest from the notes your feed ranks highest, and read it to you. Nothing plays until you press play."

        override fun refresh() {
            graph.scope.launch { loadDigests(settings.value.identityHex) }
        }

        override fun make() {
            if (_digests.value.generation != null) return
            graph.scope.launch {
                val s = settings.value
                _digests.update { it.copy(error = null, makeStatus = null, makeStatusIsError = false, generation = DigestGeneration(status = "Writing…", startedAt = nowSec())) }
                try {
                    val (posts, profiles) = ensureFeed(s)
                    val message = writeDigest(posts, profiles, s)
                    _digests.update { it.copy(makeStatus = message, makeStatusIsError = message.startsWith("Digest failed")) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _digests.update { it.copy(makeStatus = e.message, makeStatusIsError = true) }
                } finally {
                    _digests.update { it.copy(generation = null) }
                }
            }
        }

        override fun audioSource(d: DigestRecord): AudioSource? = audioFile(d).takeIf { it.isFile && it.length() > 0 }?.let { AudioSource.Local(it) }

        override fun canMakeAudio(): Boolean = settings.value.ttsModel.trim().isNotEmpty()

        override suspend fun makeAudio(d: DigestRecord): File? {
            val s = settings.value
            val audio = Tts.synthesize(
                Tts.Config(
                    apiBaseUrl = s.apiBaseUrl,
                    apiKey = s.apiKey,
                    model = s.ttsModel.trim(),
                    voice = s.ttsVoice.trim().ifEmpty { null },
                    format = "mp3",
                    http = graph.http,
                ),
                d.text,
            )
            return withContext(Dispatchers.IO) {
                val file = audioFile(d)
                file.parentFile?.mkdirs()
                val tmp = File(file.parentFile, file.name + ".part")
                tmp.writeBytes(audio)
                if (!tmp.renameTo(file)) {
                    tmp.delete()
                    throw Exception("Could not save the audio on this device.")
                }
                file
            }
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    override fun start() {
        if (started) return
        started = true
        graph.signers.signerRelays = settings.value.signerRelays
        graph.scope.launch {
            ProcessLifecycleOwner.get().lifecycle.addObserver(foreground)
            followIdentity(settings.value)
            // First run: nothing is set up, so start where the setup is.
            if (settings.value.npub.isBlank()) _tabs.tryEmit(AppTab.Tune)
            autoCheck()
        }
        ticker = graph.scope.launch {
            while (isActive) {
                delay(SnapshotLogic.CHECK_EVERY_MS)
                autoCheck()
            }
        }
    }

    override fun stop() {
        if (!started) return
        started = false
        ticker?.cancel()
        runJob?.cancel()
        graph.scope.launch { ProcessLifecycleOwner.get().lifecycle.removeObserver(foreground) }
    }

    override val gateActive: StateFlow<Boolean> = MutableStateFlow(false)

    @Composable
    override fun Gate(modifier: Modifier) = Unit

    @Composable
    override fun FeedHeader(modifier: Modifier) = ByokFeedHeader(this, modifier)

    @Composable
    override fun DigestExtras(modifier: Modifier) = ByokDigestExtras(this, modifier)

    @Composable
    override fun Tune(modifier: Modifier) = ByokTune(this, graph, modifier)

    /** The ranker reads the rules from the feedback store on every run; nothing to send. */
    override fun onFeedbackRulesChanged(rules: List<FeedbackRule>) = Unit

    // ─── Tune actions (web ui.ts) ────────────────────────────────────────────

    /** "Finish setup": straight to Tune, at the first missing essential. */
    internal fun goToTune() {
        focusField = SettingsValidation.setupSteps(settings.value).firstOrNull { it.state == SettingsValidation.StepState.Next }?.field
        _tabs.tryEmit(AppTab.Tune)
    }

    internal fun isFirstSetup(): Boolean = SettingsValidation.validate(settings.value) != null

    /** Save the form. Returns the problem when it does not validate. */
    internal fun save(updated: ByokSettings, speechVoice: String?): FieldProblem? {
        val problem = SettingsValidation.setupProblem(updated)
        if (problem != null) {
            tuneStatus = problem.message to true
            if (problem.isExtra) showAllSettings = true
            focusField = problem.field
            return problem
        }
        val firstSetup = isFirstSetup()
        store.save(updated)
        speechVoice?.let { v -> graph.deviceSettings.update { it.copy(speechVoice = v) } }
        graph.signers.signerRelays = updated.signerRelays
        tuneStatus = "Interests and feed settings saved." to false
        draft = updated
        // A feed that was waiting on setup now only waits for Refresh.
        if (currentPosts.isEmpty() && emptyCard.value?.configured == false && emptyCard.value?.message == null) emptyCard.value = EmptyCard(configured = true)
        graph.scope.launch {
            followIdentity(updated)
            if (firstSetup) {
                _tabs.tryEmit(AppTab.Feed)
                launchRun(auto = false)
            } else {
                autoCheck()
            }
        }
        return null
    }

    /** One small request with the scoring model, so a wrong key or model shows before a run. */
    internal suspend fun testModel(s: ByokSettings) {
        catalogStatus = "Testing one small model request…"
        catalogStatus = try {
            chatCompletion(LlmConfig(s.apiBaseUrl, s.apiKey, s.model, timeoutMs = 15_000, http = graph.http), listOf(ChatMessage("user", "Reply with OK only.")))
            "Model connection works. Save and rank your feed."
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            "${e.message}. Check the key/model."
        }
    }

    internal suspend fun loadModels(s: ByokSettings) {
        catalogStatus = "Loading…"
        try {
            val models = ModelCatalog.fetchModels(graph.context, graph.http, s.apiBaseUrl.trim(), s.apiKey.trim(), force = true)
            catalog = models
            catalogStatus = "${models.size} models available"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            catalogStatus = e.message ?: "Model list failed"
        }
    }

    /** Show a cached catalog at once, so the pickers are useful on open. */
    internal fun loadCachedCatalog(apiBaseUrl: String) {
        if (apiBaseUrl.isBlank() || catalog.isNotEmpty()) return
        ModelCatalog.loadCached(graph.context, apiBaseUrl.trim())?.let {
            catalog = it
            catalogStatus = "${it.size} models (cached)"
        }
    }

    /** "Use recommended": fills the per-role models from the loaded catalog. */
    internal fun recommend(s: ByokSettings): ByokSettings {
        val models = ModelCatalog.loadCached(graph.context, s.apiBaseUrl.trim())
        if (models == null) {
            catalogStatus = "Load the model list first"
            return s
        }
        val picks = ModelCatalog.suggestModels(s.apiBaseUrl.trim(), models)
        catalogStatus = "Recommended models filled in"
        return s.copy(model = picks.scoring ?: s.model, digestModel = picks.digest ?: s.digestModel, learnerModel = picks.learner ?: s.learnerModel)
    }

    /** Another provider: its remembered base URL and models; keys are never kept per provider. */
    internal fun changeProvider(current: ByokSettings, provider: String): ByokSettings {
        store.saveProviderDraft(current.provider, current)
        val d = store.providerDraft(provider)
        val saved = settings.value
        catalog = emptyList()
        catalogStatus = "Provider changed. Add its key and test the connection."
        return current.copy(
            provider = provider,
            apiBaseUrl = d.apiBaseUrl,
            apiKey = if (provider == saved.provider) saved.apiKey else "",
            model = d.model,
            digestModel = d.digestModel,
            learnerModel = d.learnerModel,
            scorer = "chat",
        )
    }

    /** "Update learned taste": fetch likes now and fold them in. */
    internal fun regenerateLearned() {
        if (isRunning) return
        val s = settings.value
        SettingsValidation.validate(s)?.let {
            learnStatus = "Config error: $it"
            return
        }
        if (!s.learnFromLikes) {
            learnStatus = "Enable Learn from my likes in Tune before updating learned taste."
            return
        }
        isRunning = true
        _running.value = true
        learnStatus = "Fetching likes..."
        graph.scope.launch {
            try {
                val prompt = learning.learnIncrementally(graph.scope, Fetcher(graph.relayPool, s.relays), s, force = true).await()
                if (!prompt.isNullOrEmpty() && activeLearningResult(s)) _learned.value = prompt
                learnStatus = if (!prompt.isNullOrEmpty()) {
                    "Learned taste is up to date. It applies to future notes; unchanged likes cost no model call."
                } else {
                    "No likes to learn from yet."
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                learnStatus = "Error: ${e.message}"
            } finally {
                isRunning = false
                _running.value = false
            }
        }
    }

    internal fun resetLearned() {
        graph.scope.launch {
            resetStatus = try {
                learning.reset(settings.value)
                _learned.value = ""
                "Learned taste cleared. Only likes from now on will shape a new one."
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                e.message
            }
        }
    }

    internal fun clearScores() {
        graph.scope.launch {
            scores.clear()
            graph.toasts.show("Cached scores cleared")
        }
    }

    internal fun switchToHosted() = graph.modeStore.set(AppMode.Hosted)

    // ─── This device (for the shared "Privacy and this device" section) ──────

    /**
     * The settings of this mode for "Export settings" (web device-data.ts): the model key only
     * when the reader ticked the box; the learned taste and signer secrets never.
     */
    fun exportableSettings(includeKey: Boolean): JsonObject {
        val s = settings.value
        val all = AppJson.encodeToJsonElement(ByokSettings.serializer(), s).jsonObject
        return if (includeKey) JsonObject(all + ("apiKey" to JsonPrimitive(s.apiKey))) else all
    }

    /** "Clear all data on this device": everything this mode keeps, in memory too. */
    suspend fun clearDeviceData() {
        runJob?.cancel()
        store.clear()
        scores.clear()
        graph.records.clear("learned:")
        graph.records.clear("history:byok:")
        graph.records.clear("feed:byok:")
        ModelCatalog.clear(graph.context)
        withContext(Dispatchers.IO) { audioDir().deleteRecursively() }
        draft = null
        catalog = emptyList()
        catalogStatus = ""
        tuneStatus = null
        identityKnown = false
        _digests.value = DigestListState()
        followIdentity(settings.value)
    }
}
