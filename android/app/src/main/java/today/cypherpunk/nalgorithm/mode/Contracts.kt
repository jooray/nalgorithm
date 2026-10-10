package today.cypherpunk.nalgorithm.mode

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.io.File

/**
 * How the shared app talks to a mode. The web app wires hosted and BYOK into one
 * set of shared views through hooks (DigestBackend, setRulesSync,
 * setFeedbackIdentity…); these are the same seams, typed.
 *
 * Exactly one [ModeController] is active at a time. Switching mode keeps both
 * setups (the inactive one is just not started).
 */
interface ModeController {
    val mode: AppMode

    /** Hex pubkey of whoever is reading, or null before sign-in / setup. */
    val reader: StateFlow<String?>

    /** Relays to read and publish through for this mode (actions, profiles, show notes). */
    fun relays(): List<String>

    val feed: FeedSource
    val digests: DigestBackend

    /** Boot the mode (session check, first loads). Idempotent. */
    fun start()

    /** Stop background work when the mode is switched away from. */
    fun stop()

    /**
     * Full-screen gate in front of the tabs (hosted: login, startup error;
     * BYOK: none). Render [Gate]; while [gateActive] is true, tabs are hidden.
     */
    val gateActive: StateFlow<Boolean>

    @Composable
    fun Gate(modifier: Modifier)

    /** Mode-specific content above the feed list: banners, paywall, empty-state steps, progress. */
    @Composable
    fun FeedHeader(modifier: Modifier)

    /** Mode-specific content in the digest tab under the list header (hosted: schedule line and nudge). */
    @Composable
    fun DigestExtras(modifier: Modifier)

    /** The whole Tune tab for this mode (it embeds the shared sections from ui/tune/SharedSections.kt). */
    @Composable
    fun Tune(modifier: Modifier)

    /**
     * A link preview card for [url] (hosted: the server's /preview, shown when the
     * reader turned previews on). Null when the mode has none, they are off, or
     * the page has nothing to show.
     */
    suspend fun linkPreview(url: String): LinkPreview? = null

    /** The private more/less rules changed (hosted: send to the server; BYOK: nothing, the ranker reads them). */
    fun onFeedbackRulesChanged(rules: List<FeedbackRule>)

    /**
     * Tabs the mode wants shown (web: showTab): Tune for a missing prompt or "Open Tune",
     * Feed for the paywall or after the first prompt is saved. The shell collects this.
     */
    val tabRequests: Flow<AppTab> get() = emptyFlow()
}

/** The three tabs, for [ModeController.tabRequests]. */
enum class AppTab { Feed, Digests, Tune }

/** A link preview card. [imageUrl] is fetched with [imageHeaders] (the hosted image proxy needs the session). */
@Immutable
data class LinkPreview(
    val url: String,
    val title: String? = null,
    val description: String? = null,
    val siteName: String? = null,
    val imageUrl: String? = null,
    val imageHeaders: Map<String, String> = emptyMap(),
)

// ─── Feed ────────────────────────────────────────────────────────────────────

@Immutable
data class FeedUiState(
    /** Ranked posts, in the server's/ranker's order; the feed screen applies feed order and private hides. */
    val posts: List<ScoredPost> = emptyList(),
    val profiles: Map<String, ProfileData> = emptyMap(),
    /** First load with nothing on screen yet. */
    val loading: Boolean = false,
    /** A background run is going ("Ranking 40 of 200…"); shown as a quiet busy line. */
    val busyText: String? = null,
    /** 0..1 when known. */
    val progress: Float? = null,
    /** Unix seconds of the ranking on screen. */
    val rankedAt: Long? = null,
    /** A quiet one-line notice under the header ("Showing the ranking saved on this device"). */
    val notice: String? = null,
    val error: String? = null,
    /** Newer ranking available but not applied because the reader is scrolled down. */
    val pendingNewCount: Int = 0,
    /**
     * Notes (folded display ids, see snapshot-logic.ts freshIds) that came with the latest run
     * and were not on screen before. With "new arrivals first" they go on top under
     * "New since last refresh". Posts marked [ScoredPost.isNew] count as fresh too.
     */
    val fresh: List<String> = emptyList(),
)

interface FeedSource {
    val state: StateFlow<FeedUiState>

    /** Pull to refresh / the Refresh button. */
    fun refresh()

    /** Apply a ranking that arrived while scrolled down (the "new" pill). */
    fun applyPending()

    /** The feed tab became visible / hidden: live checks run only while it is. */
    fun setVisible(visible: Boolean)

    /**
     * Whether the feed list is scrolled to (near) the top (web: scrollY <= 80 px). A
     * ranking that arrives while the reader is further down waits behind the "new" pill.
     */
    fun setAtTop(atTop: Boolean) {}
}

// ─── Digests ─────────────────────────────────────────────────────────────────

@Immutable
data class DigestGeneration(
    /** Text streamed so far (BYOK writes in the app and streams). */
    val text: String = "",
    val status: String = "",
    /** Unix seconds the run started (the mini player's clock). */
    val startedAt: Long? = null,
    val error: String? = null,
)

@Immutable
data class DigestListState(
    val digests: List<DigestRecord> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    /** A digest is being written (here or on the server). */
    val generation: DigestGeneration? = null,
    /** False until the first list load answered (from the server or from the device). */
    val known: Boolean = false,
    /**
     * One line under the make button (web #list-status) when no digest is being written:
     * "Asking for a digest…", "Your digest has arrived.", or why a run ended without one.
     */
    val makeStatus: String? = null,
    val makeStatusIsError: Boolean = false,
)

/** Where a digest's audio comes from: a URL (with headers, for the hosted API) or a local file. */
sealed interface AudioSource {
    data class Remote(val url: String, val headers: Map<String, String> = emptyMap()) : AudioSource
    data class Local(val file: File) : AudioSource
}

interface DigestBackend {
    val mode: AppMode
    val state: StateFlow<DigestListState>

    /** The button that makes the first digest, and the same button once one exists. */
    val makeLabel: String
    val makeAnotherLabel: String
    /** What the empty hero says about getting the first one. */
    val emptyText: String

    /** Reload the list (pull to refresh, tab shown). */
    fun refresh()

    /** Write a new digest (BYOK in the app, hosted asks the server). Errors land in [state]. */
    fun make()

    /** Hosted: one digest with its notes when the list did not carry them. */
    suspend fun loadFull(d: DigestRecord): DigestRecord? = null

    /** Where to download / stream this digest's audio from, or null when it has none. */
    fun audioSource(d: DigestRecord): AudioSource?

    /** BYOK with a TTS model set: synthesize audio for [d] into a file. */
    suspend fun makeAudio(d: DigestRecord): File? = null
    fun canMakeAudio(): Boolean = false

    /**
     * The reader listened to [d] for real (half of it, or to the end), once per app run
     * (web: onFirstListen). Hosted offers daily delivery then.
     */
    fun onListened(d: DigestRecord) {}

    /** Whether the digest text should be read aloud with the phone's own speech engine (BYOK without TTS). */
    fun speechOnly(d: DigestRecord): Boolean = d.audioUrl == null && audioSource(d) == null
}
