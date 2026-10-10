package today.cypherpunk.nalgorithm.audio

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.mode.AudioSource
import today.cypherpunk.nalgorithm.mode.DigestBackend
import today.cypherpunk.nalgorithm.mode.DigestGeneration
import today.cypherpunk.nalgorithm.mode.DigestListState
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.ui.digest.DigestScreenImpl
import today.cypherpunk.nalgorithm.ui.digest.MiniPlayerImpl
import java.io.File
import java.util.Locale

enum class NotesTab { Notes, Text }

/** A one-line message in the player's hint slot (download done, audio failed…). */
data class PlayerNotice(val text: String, val isError: Boolean)

/** Everything the Digests tab and the mini player draw, besides the player's own state. */
data class DigestUi(
    val backend: DigestBackend? = null,
    /** Newest first, with show notes fetched in this session merged in. */
    val digests: List<DigestRecord> = emptyList(),
    val selectedId: String? = null,
    val notesOpen: Boolean = false,
    val notesTab: NotesTab = NotesTab.Notes,
    val listLoading: Boolean = false,
    val listError: String? = null,
    val known: Boolean = false,
    val generation: DigestGeneration? = null,
    /** Bring your own key: digests with audio made in this session. */
    val made: Set<String> = emptySet(),
    /** Digests whose audio is in the offline cache. */
    val offline: Set<String> = emptySet(),
    val makingAudio: Boolean = false,
    val downloading: Boolean = false,
    val notice: PlayerNotice? = null,
    /** Digests whose show notes could not be loaded. */
    val notesFailed: Set<String> = emptySet(),
) {
    val selected: DigestRecord? get() = digests.firstOrNull { it.id == selectedId }
    /** A digest is being written (here or on the server). */
    val running: Boolean get() = generation != null && generation.error == null
}

/**
 * The digest side of the app: the one player, the offline audio cache, Read aloud,
 * MP3 downloads, and fetching the newest digest's audio right after launch and in
 * the background (web/src/digest-view.ts, player.ts, offline-audio.ts).
 */
class DigestAudio(private val graph: AppGraph) {
    private val context: Context = graph.context
    private val scope = graph.scope
    private val prefs = context.getSharedPreferences("digest_player", Context.MODE_PRIVATE)
    private val store = object : KeyValueStore {
        override fun getItem(key: String): String? = prefs.getString(key, null)
        override fun setItem(key: String, value: String) { prefs.edit().putString(key, value).apply() }
        override fun removeItem(key: String) { prefs.edit().remove(key).apply() }
    }
    val resume = ResumeStore(store)
    val cache = OfflineAudioCache(File(context.filesDir, "audio"), graph.records, graph.http)

    val player = DigestPlayer(
        context = context,
        scope = scope,
        resume = resume,
        loadSpeed = { normalizeSpeed(graph.deviceSettings.settings.value.playbackSpeed) },
        saveSpeed = { v -> graph.deviceSettings.update { it.copy(playbackSpeed = v) } },
        voiceName = { graph.deviceSettings.settings.value.speechVoice },
    )

    private val _ui = MutableStateFlow(DigestUi())
    val ui: StateFlow<DigestUi> = _ui.asStateFlow()

    private val _cacheStatus = MutableStateFlow<String?>(null)
    /** "12.3 MB cached. Newest three audio digests, up to 30 MB; …", or the last cache message, or null. */
    val cacheStatus: StateFlow<String?> = _cacheStatus.asStateFlow()

    private val madeFiles = HashMap<String, File>()
    private val offlineFiles = HashMap<String, File>()
    private val fullNotes = HashMap<String, DigestRecord>()
    private val fetchingNotes = HashSet<String>()
    private var owner: String = "none"
    private var lastList: List<DigestRecord>? = null
    private var pendingRoute: String? = null
    private var selectNewestOnce = false
    private var lastLaunchFetch = 0L
    private var audioSync: Job? = null
    private var listenedFired = false
    private var listenedListener: ((String) -> Unit)? = null

    init {
        DigestLabels.use24Hour = DateFormat.is24HourFormat(context)
        runCatching { DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEdMMM") }.getOrNull()?.let { DigestLabels.dayPattern = it }
        observeMode()
        scope.launch {
            graph.deviceSettings.settings.map { it.cacheAudio }.distinctUntilChanged().collect { on ->
                if (on) refreshAudioCache()
            }
        }
        scope.launch {
            player.state.collect { s -> noteListening(s) }
        }
        scope.launch {
            val bytes = cache.bytes()
            if (bytes > 0 && _cacheStatus.value == null) _cacheStatus.value = cachedText(bytes)
        }
        runCatching {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                // Backgrounded: keep the place.
                override fun onStop(owner: LifecycleOwner) = player.checkpoint()
            })
        }
    }

    // ─── public API ──────────────────────────────────────────────────────────

    /**
     * Called from MainActivity.onCreate. In hosted mode, once signed in: refresh the list,
     * download the newest digest's audio into the cache at once (so play works instantly and
     * offline) and put it in the player, paused. Also keeps the background fetch scheduled.
     */
    fun onLaunch() {
        // onCreate also runs on every fold, unfold and rotation: the newest digest is put in
        // front once per process, and the list is fetched again only after a while.
        val now = System.currentTimeMillis()
        if (lastLaunchFetch == 0L) {
            LatestDigestWorker.schedule(context)
            val newest = _ui.value.digests.firstOrNull()
            if (newest != null && _ui.value.known) selectInternal(newest.id, openNotes = false)
            else selectNewestOnce = true
        }
        if (now - lastLaunchFetch < LAUNCH_REFETCH_MS) return
        lastLaunchFetch = now
        scope.launch { fetchLatest(startMode = false) }
    }

    /** The background job's work: the newest hosted digest's audio into the cache. Returns whether it is there. */
    suspend fun fetchLatestInBackground(): Boolean = fetchLatest(startMode = true)

    suspend fun clearCache() {
        cache.clear()
        offlineFiles.clear()
        _ui.update { it.copy(offline = emptySet()) }
        _cacheStatus.value = "Cached audio removed. Downloads you saved outside the app are unchanged."
        val d = _ui.value.selected
        if (d != null && !player.current.playing) player.load(sourceFor(d))
    }

    /** Select a digest (a `digest/<id>` link); waits for the list when it has not arrived yet. */
    fun openDigest(id: String, openNotes: Boolean = false) {
        if (_ui.value.digests.any { it.id == id }) selectDigest(id, openNotes = openNotes, play = false)
        else pendingRoute = id
    }

    /** Stop playback (sign-out, mode switch). */
    fun stop() = player.load(null)

    /**
     * Called once per process when the reader has listened to a digest for real: half of it,
     * or to the end. The hosted schedule nudge waits for this, not for the first play press.
     */
    fun onFirstListen(cb: (digestId: String) -> Unit) { listenedListener = cb }

    // ─── list ────────────────────────────────────────────────────────────────

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun observeMode() {
        scope.launch {
            graph.modeStore.mode.flatMapLatest { mode ->
                if (mode == null) flowOf(null)
                else {
                    val ctrl = graph.controller(mode)
                    combine(ctrl.digests.state, ctrl.reader) { state, reader -> Triple(ctrl.digests, state, reader) }
                }
            }.collect { t ->
                if (t == null) applyBackend(null, DigestListState(), "none")
                else applyBackend(t.first, t.second, "${t.first.mode.name.lowercase(Locale.ROOT)}:${t.third ?: "setup"}")
            }
        }
    }

    private fun applyBackend(backend: DigestBackend?, state: DigestListState, newOwner: String) {
        if (newOwner != owner) {
            // Another reader or mode: nothing of the previous one's stays in the player.
            owner = newOwner
            player.load(null)
            madeFiles.clear(); offlineFiles.clear(); fullNotes.clear(); fetchingNotes.clear()
            lastList = null
            listenedFired = false
            _ui.value = DigestUi(backend = backend)
        }
        _ui.update {
            it.copy(
                backend = backend,
                listLoading = state.loading,
                listError = state.error,
                known = state.known,
                generation = state.generation,
            )
        }
        if (state.digests != lastList) {
            val previous = lastList
            lastList = state.digests
            // A digest that was not there before (just written, here or on the server) comes to the front.
            val arrived = previous?.takeIf { it.isNotEmpty() }?.let { prev ->
                val before = prev.map { it.id }.toSet()
                newestFirst(state.digests).firstOrNull { it.id !in before }
            }
            val busy = player.current.playing || player.current.loading
            val newest = if (selectNewestOnce && state.known && !busy) newestFirst(state.digests).firstOrNull()?.id else null
            setDigests(state.digests, select = arrived?.id?.takeIf { !busy } ?: newest)
        }
    }

    private fun merged(list: List<DigestRecord>): List<DigestRecord> = newestFirst(list).map { d ->
        val full = fullNotes[d.id]
        if (full != null && d.notes == null) d.copy(notes = full.notes, profiles = full.profiles ?: d.profiles) else d
    }

    private fun setDigests(list: List<DigestRecord>, select: String? = null) {
        val digests = merged(list)
        val kept = digests.map { it.id }.toSet()
        madeFiles.keys.retainAll(kept)
        for (d in digests) rememberSnapshots(d)
        val saved = prefs.getString(selectionKey(), null)
        // A digest link that arrived before its list wins over the current selection, once.
        val route = pendingRoute?.takeIf { id -> digests.any { it.id == id } }
        if (route != null) pendingRoute = null
        val want = select ?: route ?: _ui.value.selectedId ?: saved
        val keep = if (want != null && digests.any { it.id == want }) want else digests.firstOrNull()?.id
        if (select != null && digests.isNotEmpty()) selectNewestOnce = false
        _ui.update { it.copy(digests = digests, made = madeFiles.keys.toSet()) }
        selectInternal(keep, openNotes = false)
        refreshAudioCache()
    }

    private fun rememberSnapshots(d: DigestRecord) {
        val snaps = d.profiles ?: return
        val known = graph.profiles.profiles.value
        val fresh = snaps.filterKeys { it !in known }.mapValues { (pk, s) -> ProfileData(pubkey = pk, name = s.name, picture = s.picture, nip05 = s.nip05) }
        if (fresh.isNotEmpty()) graph.profiles.remember(fresh)
    }

    private fun selectionKey(): String = "nalgorithm_selected_digest_${owner.replace(':', '_')}"

    // ─── selection ───────────────────────────────────────────────────────────

    private fun playable(d: DigestRecord): AudioSource? {
        madeFiles[d.id]?.let { return AudioSource.Local(it) }
        offlineFiles[d.id]?.let { return AudioSource.Local(it) }
        val src = _ui.value.backend?.audioSource(d) ?: return null
        return if (src is AudioSource.Remote && safeAudioUrl(src.url) == null) null else src
    }

    fun hasAudio(d: DigestRecord): Boolean = playable(d) != null

    private fun sourceFor(d: DigestRecord) = PlayerSource(
        key = keyOf(d),
        digestId = d.id,
        title = "Your morning digest",
        subtitle = DigestLabels.whenLabel(d.createdAt),
        audio = playable(d),
        text = d.text,
        durationSeconds = exactSeconds(d),
    )

    private fun selectInternal(id: String?, openNotes: Boolean) {
        val prev = _ui.value
        val changed = id != prev.selectedId
        if (id != null) prefs.edit().putString(selectionKey(), id).apply()
        _ui.update {
            it.copy(
                selectedId = id,
                notesTab = if (changed) NotesTab.Notes else it.notesTab,
                notesOpen = when {
                    openNotes -> true
                    changed -> false
                    else -> it.notesOpen
                },
                notice = if (changed) null else it.notice,
            )
        }
        val d = _ui.value.selected
        player.load(d?.let(::sourceFor))
    }

    /** A digest in the list was pressed (its play button: [play]; its text: [openNotes]). */
    fun selectDigest(id: String, openNotes: Boolean, play: Boolean) {
        selectInternal(id, openNotes)
        if (play) playPressed()
    }

    /** The play button of the entry for [id]. */
    fun entryPlay(id: String) {
        val s = player.current
        when {
            id == _ui.value.selectedId && (s.playing || s.loading) -> player.pause()
            id == _ui.value.selectedId -> playPressed()
            else -> selectDigest(id, openNotes = false, play = true)
        }
    }

    fun playPressed() {
        _ui.update { it.copy(notice = null) }
        player.play()
    }

    fun togglePressed() {
        if (player.current.playing || player.current.loading) player.pause() else playPressed()
    }

    fun toggleNotes() = _ui.update { it.copy(notesOpen = !it.notesOpen) }
    fun setNotesTab(tab: NotesTab) = _ui.update { it.copy(notesTab = tab) }

    /** The latest digest into the main player (the mini player); [play] only from a press. */
    fun openLatest(play: Boolean) {
        val d = _ui.value.digests.firstOrNull()
        if (d != null && d.id != _ui.value.selectedId) selectInternal(d.id, false)
        if (play && d != null) playPressed()
    }

    // ─── actions ─────────────────────────────────────────────────────────────

    fun make() {
        val backend = _ui.value.backend ?: return
        if (_ui.value.running) return
        backend.make()
    }

    fun retryList() { _ui.value.backend?.refresh() }

    /** Hosted: one digest with its notes when the list did not carry them. */
    fun fetchFull(d: DigestRecord) {
        val backend = _ui.value.backend ?: return
        if (!fetchingNotes.add(d.id)) return
        val forOwner = owner
        scope.launch {
            try {
                val full = backend.loadFull(d)
                if (forOwner != owner) return@launch
                val next = (full ?: d).let { it.copy(notes = it.notes ?: d.notes ?: emptyList()) }
                fullNotes[d.id] = next
                rememberSnapshots(next)
                _ui.update { it.copy(digests = merged(it.digests), notesFailed = it.notesFailed - d.id) }
            } catch (_: Exception) {
                if (forOwner == owner) _ui.update { it.copy(notesFailed = it.notesFailed + d.id) }
            } finally {
                fetchingNotes.remove(d.id)
            }
        }
    }

    /** Bring your own key with a TTS model: make audio for the selected digest. */
    fun makeAudio() {
        val d = _ui.value.selected ?: return
        val backend = _ui.value.backend ?: return
        if (_ui.value.makingAudio) return
        _ui.update { it.copy(makingAudio = true, notice = null) }
        val forOwner = owner
        scope.launch {
            try {
                val file = backend.makeAudio(d) ?: throw IllegalStateException("no audio came back")
                if (forOwner != owner) return@launch
                madeFiles[d.id] = file
                _ui.update { it.copy(made = madeFiles.keys.toSet()) }
                if (graph.deviceSettings.settings.value.cacheAudio) {
                    try { cache.save(owner, d.id, d.createdAt, file) } catch (_: Exception) {
                        _cacheStatus.value = "Audio is ready; too large to cache. Use Download MP3."
                    }
                }
                // Same digest, now with a real audio file: swap the source under the player.
                if (_ui.value.selectedId == d.id) { player.load(null); player.load(sourceFor(d)) }
            } catch (e: Exception) {
                _ui.update { it.copy(notice = PlayerNotice("Audio failed: ${e.message ?: "unknown error"}", true)) }
            } finally {
                _ui.update { it.copy(makingAudio = false) }
            }
        }
    }

    /** A file to save for the selected digest, and its name; null when it has no audio. Errors land in the notice. */
    suspend fun prepareDownload(made: Boolean): Pair<File, String>? {
        val d = _ui.value.selected ?: return null
        if (made) return madeFiles[d.id]?.let { it to madeAudioFileName(d) }
        val source = playable(d) ?: return null
        _ui.update { it.copy(downloading = true, notice = null) }
        return try {
            val file = madeFiles[d.id] ?: cache.fetch(owner, d.id, source, OfflineAudioCache.DOWNLOAD_MAX_BYTES)
            file to mp3FileName(d)
        } catch (e: Exception) {
            _ui.update { it.copy(notice = PlayerNotice("${e.message ?: "Audio download failed."} Try online again.", true)) }
            null
        } finally {
            _ui.update { it.copy(downloading = false) }
        }
    }

    /** Copy a prepared file to where the reader chose ([target] null: they cancelled). */
    suspend fun finishDownload(file: File, target: Uri?) {
        try {
            if (target == null) return
            withContext(Dispatchers.IO) {
                context.contentResolver.openOutputStream(target, "w")?.use { out -> file.inputStream().use { it.copyTo(out) } }
                    ?: throw IllegalStateException("Could not write the file.")
            }
            _ui.update { it.copy(notice = PlayerNotice("MP3 saved. Keep the file for reliable offline playback.", false)) }
        } catch (e: Exception) {
            _ui.update { it.copy(notice = PlayerNotice("${e.message ?: "Could not save the MP3."} Try again.", true)) }
        } finally {
            cache.discard(file)
        }
    }

    // ─── offline cache ───────────────────────────────────────────────────────

    private fun online(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun cachedText(bytes: Long): String =
        "${String.format(Locale.ROOT, "%.1f", bytes / 1024.0 / 1024.0)} MB cached. Newest three audio digests, up to 30 MB; they stay on this phone until you remove them or clear the app's storage."

    /** Bring the newest three digests' audio onto the phone, then point the player at the local files. */
    fun refreshAudioCache(): Job {
        audioSync?.takeIf { it.isActive }?.let { return it }
        val job = scope.launch { syncCache() }
        audioSync = job
        return job
    }

    private suspend fun syncCache() {
        val forOwner = owner
        val backend = _ui.value.backend ?: return
        val list = _ui.value.digests.take(OfflineAudioCache.AUDIO_COUNT)
        for (d in list) {
            var file = cache.read(forOwner, d.id)
            val remote = backend.audioSource(d) as? AudioSource.Remote
            if (file == null && remote != null && safeAudioUrl(remote.url) != null && graph.deviceSettings.settings.value.cacheAudio && online()) {
                try {
                    val tmp = cache.fetch(forOwner, d.id, remote)
                    if (forOwner != owner || !graph.deviceSettings.settings.value.cacheAudio) { cache.discard(tmp); return }
                    val saved = cache.save(forOwner, d.id, d.createdAt, tmp)
                    if (!saved) {
                        _cacheStatus.value = "Audio plays this session, but this device could not save it offline."
                        continue
                    }
                    file = cache.read(forOwner, d.id)
                } catch (_: Exception) {
                    _cacheStatus.value = "Could not cache some audio. Playback and Download MP3 remain available online."
                    continue
                }
            }
            if (forOwner != owner) return
            if (file != null) offlineFiles[d.id] = file
        }
        val keep = list.map { it.id }.toSet()
        offlineFiles.keys.retainAll(keep)
        _ui.update { it.copy(offline = offlineFiles.keys.toSet()) }
        val bytes = cache.bytes()
        if (bytes > 0) _cacheStatus.value = cachedText(bytes)
        val d = _ui.value.selected
        val s = player.current
        if (d != null && !s.playing && !s.loading) player.load(sourceFor(d))
    }

    // ─── launch and background ───────────────────────────────────────────────

    private suspend fun fetchLatest(startMode: Boolean): Boolean {
        if (graph.modeStore.mode.value != AppMode.Hosted) return false
        val ctrl = graph.hosted
        var reader = withTimeoutOrNull(if (startMode) 2_000 else 20_000) { ctrl.reader.first { it != null } }
        if (reader == null && startMode) {
            ctrl.start()
            reader = withTimeoutOrNull(20_000) { ctrl.reader.first { it != null } }
        }
        if (reader == null) return false
        val backend = ctrl.digests
        val before = backend.state.value
        backend.refresh()
        // The hosted list answers asynchronously: wait for the state that follows this refresh.
        withTimeoutOrNull(30_000) { backend.state.first { it !== before && it.known && !it.loading } }
        val newest = newestFirst(backend.state.value.digests).firstOrNull() ?: return false
        if (!graph.deviceSettings.settings.value.cacheAudio) return false
        val forOwner = "hosted:$reader"
        if (cache.read(forOwner, newest.id) != null) return true
        // The list collector may already be downloading it; join that rather than fetching twice.
        audioSync?.takeIf { it.isActive && owner == forOwner }?.join()
        if (cache.read(forOwner, newest.id) != null) return true
        val remote = backend.audioSource(newest) as? AudioSource.Remote ?: return false
        return try {
            val tmp = cache.fetch(forOwner, newest.id, remote)
            val kept = cache.save(forOwner, newest.id, newest.createdAt, tmp)
            if (kept && owner == forOwner) refreshAudioCache()
            kept
        } catch (_: Exception) {
            false
        }
    }

    private fun noteListening(s: PlayerState) {
        if (listenedFired || s.source == null || s.dur <= 0) return
        if (!s.played && s.pos < s.dur * 0.5) return
        val d = _ui.value.selected ?: return
        listenedFired = true
        // Hosted offers daily delivery after a real listen (web onFirstListen).
        _ui.value.backend?.onListened(d)
        listenedListener?.invoke(d.id)
    }
}

private const val LAUNCH_REFETCH_MS = 10 * 60 * 1000L

/** The Digests tab. */
@Composable
fun DigestScreen(graph: AppGraph, modifier: Modifier = Modifier) = DigestScreenImpl(graph, modifier)

/** The compact player shown on the Feed tab while a digest is playing or being written. */
@Composable
fun MiniPlayer(graph: AppGraph, onOpen: () -> Unit, modifier: Modifier = Modifier) = MiniPlayerImpl(graph, onOpen, modifier)
