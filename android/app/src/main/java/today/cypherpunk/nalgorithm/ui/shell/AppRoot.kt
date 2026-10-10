package today.cypherpunk.nalgorithm.ui.shell

import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.ImageLoader
import coil3.compose.setSingletonImageLoaderFactory
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.audio.DigestScreen
import today.cypherpunk.nalgorithm.mode.AppTab
import today.cypherpunk.nalgorithm.mode.ModeController
import today.cypherpunk.nalgorithm.nostr.SignerHost
import today.cypherpunk.nalgorithm.ui.feed.FeedScreen
import today.cypherpunk.nalgorithm.ui.feed.rememberFeedListState
import today.cypherpunk.nalgorithm.ui.notes.NoteIds
import today.cypherpunk.nalgorithm.ui.theme.CenteredColumn
import today.cypherpunk.nalgorithm.ui.theme.Nal

/**
 * The app shell (shell.ts, app.ts bootstrap): the mode choice on first run;
 * then the active mode's gate while it needs one, else the three tabs (a bottom
 * bar, or a rail on a wide window). Above everything: the offline banner, the
 * toast, and the signer sheets.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AppRoot(graph: AppGraph) {
    val c = Nal.colors
    setSingletonImageLoaderFactory { ctx ->
        ImageLoader.Builder(ctx)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { graph.http })) }
            .crossfade(true)
            .build()
    }

    val mode by graph.modeStore.mode.collectAsState()
    val controller: ModeController? = mode?.let(graph::controller)
    ModeLifecycle(graph, controller)

    val nav = remember { TabNavigator(graph.context) }
    val feedList = rememberFeedListState()
    val scope = rememberCoroutineScope()
    var openNoteId by rememberSaveable { mutableStateOf<String?>(null) }
    LinkIntents(onTab = { nav.show(it) }, onNote = { id -> nav.show(Tab.Feed); openNoteId = id })
    // A mode asks for a tab (web showTab): Tune when setup is missing, Feed after the first save or for the paywall.
    LaunchedEffect(controller) {
        controller?.tabRequests?.collect { tab ->
            nav.show(when (tab) { AppTab.Feed -> Tab.Feed; AppTab.Digests -> Tab.Digest; AppTab.Tune -> Tab.Tune })
        }
    }

    val gateActive = controller?.gateActive?.collectAsState()?.value ?: false
    val online by rememberOnline()
    val toaster = graph.toasts
    val slop = LocalViewConfiguration.current.touchSlop

    FeedVisibility(controller, visible = controller != null && !gateActive && nav.current == Tab.Feed)

    BackHandler(enabled = controller != null && !gateActive && nav.canGoBack) { nav.back() }

    CompositionLocalProvider(LocalToaster provides toaster) {
        Box(
            Modifier
                .fillMaxSize()
                .background(c.bg)
                // An Undo toast closes at the reader's next tap elsewhere; a scroll does not count.
                .pointerInput(toaster) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val up = waitForUpOrCancellation(PointerEventPass.Initial) ?: return@awaitEachGesture
                        if ((up.position - down.position).getDistance() > slop) return@awaitEachGesture
                        val inside = toaster.bounds?.contains(down.position) == true
                        if (!inside) toaster.onNextAction()
                    }
                }
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    if (e.key == Key.Z && (e.isCtrlPressed || e.isMetaPressed) && !e.isShiftPressed) return@onPreviewKeyEvent toaster.runUndo()
                    if (e.key !in PASSIVE_KEYS) toaster.onNextAction()
                    false
                },
        ) {
            Column(Modifier.fillMaxSize()) {
                if (!online) OfflineBanner()
                Box(
                    Modifier
                        .weight(1f)
                        .then(if (!online) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier),
                ) {
                    when {
                        controller == null -> ModeChoice(graph)
                        gateActive -> controller.Gate(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding())
                        else -> Tabs(graph, controller, nav, feedList, openNoteId, onNoteOpened = { openNoteId = null }) { tab ->
                            if (tab == nav.current) {
                                if (tab == Tab.Feed) scope.launch { feedList.animateScrollToItem(0) }
                            } else {
                                nav.show(tab)
                            }
                        }
                    }
                }
            }
            val tabsShown = controller != null && !gateActive
            ToastHost(
                toaster, level = 0,
                Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(bottom = if (tabsShown) Nal.tabbarHeight + 12.dp else 12.dp)
            )
        }
        SignerHost(graph.signers)
    }
}

/** Keys that move around rather than act: reaching the Undo button must not close it. */
private val PASSIVE_KEYS = setOf(
    Key.Tab, Key.ShiftLeft, Key.ShiftRight, Key.CtrlLeft, Key.CtrlRight, Key.AltLeft, Key.AltRight,
    Key.MetaLeft, Key.MetaRight, Key.CapsLock, Key.DirectionUp, Key.DirectionDown, Key.DirectionLeft,
    Key.DirectionRight, Key.PageUp, Key.PageDown, Key.MoveHome, Key.MoveEnd,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Tabs(
    graph: AppGraph,
    controller: ModeController,
    nav: TabNavigator,
    feedList: androidx.compose.foundation.lazy.LazyListState,
    openNoteId: String?,
    onNoteOpened: () -> Unit,
    onSelect: (Tab) -> Unit,
) {
    // Each tab keeps its scroll position and its fields while another is shown.
    val holder = rememberSaveableStateHolder()
    val ime = WindowInsets.isImeVisible
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= Nal.railFrom
        val content: @Composable (Modifier) -> Unit = { modifier ->
            Box(modifier) {
                holder.SaveableStateProvider(nav.current.id + ":" + controller.mode) {
                    CenteredColumn(Modifier.fillMaxSize()) {
                        when (nav.current) {
                            Tab.Feed -> FeedScreen(
                                graph, controller, feedList,
                                onOpenDigest = { nav.show(Tab.Digest) },
                                openNoteId = openNoteId,
                                onNoteOpened = onNoteOpened,
                            )
                            Tab.Digest -> DigestScreen(graph, Modifier.fillMaxSize())
                            // Feed and Digests draw under the status bar (the violet hero does); Tune starts below it.
                            Tab.Tune -> controller.Tune(Modifier.fillMaxSize().statusBarsPadding())
                        }
                    }
                }
            }
        }
        if (wide) {
            Row(Modifier.fillMaxSize()) {
                NalTabRail(nav.current, onSelect)
                content(Modifier.weight(1f).fillMaxSize().navigationBarsPadding().imePadding())
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                content(
                    Modifier.weight(1f).fillMaxSize()
                        .then(if (ime) Modifier.imePadding() else Modifier.consumeWindowInsets(WindowInsets.navigationBars)),
                )
                // The keyboard covers the bottom of the screen: the tab bar steps aside rather than riding on top of it.
                if (!ime) NalTabBar(nav.current, onSelect)
            }
        }
    }
}

/** Start the chosen mode and stop the one switched away from; both setups are kept. Feedback follows its reader. */
@Composable
private fun ModeLifecycle(graph: AppGraph, controller: ModeController?) {
    val running = remember { mutableStateOf<ModeController?>(null) }
    LaunchedEffect(controller) {
        val previous = running.value
        if (previous !== controller) {
            previous?.stop()
            controller?.start()
            running.value = controller
        }
    }
    LaunchedEffect(controller) {
        if (controller == null) graph.feedback.setIdentity(null)
        else controller.reader.collect { graph.feedback.setIdentity(it) }
    }
}

/** Live checks run only while the feed is on screen and the app is in the foreground. */
@Composable
private fun FeedVisibility(controller: ModeController?, visible: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state by lifecycle.currentStateFlow.collectAsStateWithLifecycle(minActiveState = Lifecycle.State.CREATED)
    val shown = visible && state.isAtLeast(Lifecycle.State.STARTED)
    LaunchedEffect(controller, shown) { controller?.feed?.setVisible(shown) }
    DisposableEffect(controller) { onDispose { controller?.feed?.setVisible(false) } }
}

/**
 * `nalgorithm://` links bring the app forward (after a signer or a payment in the
 * browser). A few name a place: `nalgorithm://feed`, `nalgorithm://digest`,
 * `nalgorithm://tune` and `nalgorithm://note/<id>` (the web's `#feed/note/<id>`).
 */
@Composable
private fun LinkIntents(onTab: (Tab) -> Unit, onNote: (String) -> Unit) {
    val activity = LocalActivity.current as? ComponentActivity ?: return
    var handledLaunch by rememberSaveable { mutableStateOf(false) }
    val handle = remember(onTab, onNote) {
        { intent: Intent? ->
            val target = parseAppLink(intent?.data)
            when {
                target == null -> Unit
                target.noteId != null -> onNote(target.noteId)
                target.tab != null -> onTab(target.tab)
            }
        }
    }
    LaunchedEffect(Unit) {
        if (!handledLaunch) {
            handledLaunch = true
            handle(activity.intent)
        }
    }
    DisposableEffect(activity) {
        val listener = androidx.core.util.Consumer<Intent> { handle(it) }
        activity.addOnNewIntentListener(listener)
        onDispose { activity.removeOnNewIntentListener(listener) }
    }
}

internal data class AppLink(val tab: Tab? = null, val noteId: String? = null)

/** What a `nalgorithm://` link points at, or null when it only brings the app forward. */
internal fun parseAppLink(uri: Uri?): AppLink? {
    if (uri == null || uri.scheme != "nalgorithm") return null
    val parts = listOfNotNull(uri.host) + uri.pathSegments.orEmpty()
    return parseAppLinkParts(parts)
}

internal fun parseAppLinkParts(parts: List<String>): AppLink? {
    val p = parts.filter { it.isNotEmpty() }.map { it.lowercase() }
    if (p.isEmpty()) return null
    val noteAt = p.indexOf("note")
    if (noteAt >= 0) {
        val id = p.getOrNull(noteAt + 1)
        if (NoteIds.isHex64(id)) return AppLink(Tab.Feed, id)
        id?.let { NoteIds.eventIdOf(it) }?.let { return AppLink(Tab.Feed, it) }
    }
    return Tab.of(p.first())?.let { AppLink(tab = it) }
}
