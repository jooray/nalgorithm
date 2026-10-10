package today.cypherpunk.nalgorithm.ui.feed

import kotlinx.coroutines.flow.distinctUntilChanged
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.audio.MiniPlayer
import today.cypherpunk.nalgorithm.mode.ModeController
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.ui.notes.NoteCard
import today.cypherpunk.nalgorithm.ui.notes.NoteDetailSheet
import today.cypherpunk.nalgorithm.ui.notes.peopleOf
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.theme.NalButton
import today.cypherpunk.nalgorithm.ui.theme.NalButtonKind
import today.cypherpunk.nalgorithm.ui.theme.NalSpinner
import today.cypherpunk.nalgorithm.ui.theme.NalText
import today.cypherpunk.nalgorithm.ui.theme.StateCard
import today.cypherpunk.nalgorithm.ui.theme.StateRow

/**
 * The Feed tab (#view-feed): the mini player, the header with Saved and
 * Refresh, the age and busy line, the mode's own header (banners, paywall,
 * empty states), then the ranked notes with "New since last refresh" on top.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    graph: AppGraph,
    controller: ModeController,
    listState: LazyListState,
    onOpenDigest: () -> Unit,
    modifier: Modifier = Modifier,
    /** A note to open in the detail sheet (a `nalgorithm://note/<id>` link), once it is in the feed. */
    openNoteId: String? = null,
    onNoteOpened: () -> Unit = {},
) {
    val c = Nal.colors
    val state by controller.feed.state.collectAsState()
    val settings by graph.deviceSettings.settings.collectAsState()
    val feedback by graph.feedback.state.collectAsState()
    // web: scrollY <= 80. A ranking that lands while the reader is further down waits behind the pill.
    LaunchedEffect(controller, listState) {
        snapshotFlow { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= 200 }
            .distinctUntilChanged()
            .collect { controller.feed.setAtTop(it) }
    }
    val known by graph.profiles.profiles.collectAsState()
    val reader by controller.reader.collectAsState()
    val scope = rememberCoroutineScope()
    val layout = remember(state.posts, state.fresh, settings.feedOrder, feedback) {
        FeedLogic.layout(state.posts, state.fresh, settings.feedOrder, feedback)
    }
    val people = remember(state.profiles, known) { if (known.isEmpty()) state.profiles else known + state.profiles }
    val busy = state.loading || state.busyText != null
    var savedOpen by remember { mutableStateOf(false) }

    // Pull to refresh shows its spinner only for a run the reader asked for.
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(pulled) {
        if (!pulled) return@LaunchedEffect
        delay(1_500)
        snapshotFlow { controller.feed.state.value.let { it.loading || it.busyText != null } }.first { !it }
        pulled = false
    }

    // One more lookup for people the feed shows without a profile; their cards update when it lands.
    val asked = remember(controller) { HashSet<String>() }
    LaunchedEffect(layout.source, controller) {
        val missing = layout.all.take(60).flatMap(::peopleOf).distinct().filter { it !in people && asked.add(it) }
        if (missing.isNotEmpty()) runCatching { graph.profiles.load(missing, controller.relays()) }
    }

    val firstNote = remember { FirstNoteStore(graph.context) }
    var firstNoteSeen by remember(reader) { mutableStateOf(firstNote.seen(reader)) }
    val ranked = layout.all.count { !it.post.defaultScore }
    val showFirstNote = reader != null && ranked > 0 && !firstNoteSeen

    val nowSec by produceState(System.currentTimeMillis() / 1000) {
        while (true) { delay(30_000); value = System.currentTimeMillis() / 1000 }
    }
    val age = FeedLogic.ageLabel(state.rankedAt, nowSec)

    // The status bar inset goes on the whole column: the mini player sits on top when shown,
    // and the header must not add a second inset below it.
    Column(modifier.fillMaxSize().statusBarsPadding()) {
        MiniPlayer(graph, onOpen = onOpenDigest, modifier = Modifier.fillMaxWidth())
        val pullState = rememberPullToRefreshState()
        PullToRefreshBox(
            isRefreshing = pulled && busy,
            onRefresh = { pulled = true; controller.feed.refresh() },
            state = pullState,
            modifier = Modifier.fillMaxSize(),
            indicator = {
                PullToRefreshDefaults.Indicator(
                    state = pullState,
                    isRefreshing = pulled && busy,
                    modifier = Modifier.align(Alignment.TopCenter),
                    containerColor = c.surface2,
                    color = c.accentInk,
                )
            },
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                item("head") {
                    FeedHeader(
                        savedCount = feedback.saved.size,
                        busy = busy,
                        onSaved = { savedOpen = true },
                        onRefresh = { controller.feed.refresh() },
                    )
                }
                if (state.notice != null) item("notice") { StatusLine(state.notice!!) }
                if (age.isNotEmpty() || (state.busyText != null && state.posts.isNotEmpty())) {
                    item("meta") { MetaLine(age, if (state.posts.isNotEmpty()) state.busyText else null) }
                }
                if (state.progress != null) {
                    item("progress") {
                        LinearProgressIndicator(
                            progress = { state.progress!!.coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth().padding(horizontal = Nal.gutter).padding(bottom = 10.dp),
                            color = c.accentInk,
                            trackColor = c.surface3,
                            drawStopIndicator = {},
                        )
                    }
                }
                if (state.error != null) {
                    item("error") {
                        StateCard(Modifier.padding(horizontal = Nal.gutter, vertical = 8.dp), error = true) {
                            Text(state.error!!, color = c.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
                            NalButton("Try again", { controller.feed.refresh() }, Modifier.padding(top = 14.dp), small = true)
                        }
                    }
                }
                if (showFirstNote) {
                    item("first-note") {
                        FirstNoteCard(
                            offerDigest = controller.mode == AppMode.Byok,
                            onDigest = { firstNote.markSeen(reader); firstNoteSeen = true; onOpenDigest() },
                            onDone = { firstNote.markSeen(reader); firstNoteSeen = true },
                        )
                    }
                }
                item("mode-header") { controller.FeedHeader(Modifier.fillMaxWidth()) }
                // Hosted draws its own first-load row in FeedHeader.
                if (state.loading && state.posts.isEmpty() && controller.mode == AppMode.Byok) {
                    item("loading") { StateRow(state.busyText ?: "Ranking new posts…", Modifier.padding(horizontal = Nal.gutter)) }
                }
                if (layout.allHidden) {
                    item("all-hidden") {
                        Text(
                            "Every note here is one you chose to hide. Tune lists your hidden notes and people.",
                            color = c.text2, modifier = Modifier.padding(horizontal = Nal.gutter, vertical = 12.dp),
                        )
                    }
                }
                if (layout.fresh.isNotEmpty()) item("h-fresh") { SectionHeading("New since last refresh · ${layout.fresh.size}", first = true) }
                items(layout.fresh, key = { "f:" + it.id }) { d -> Card(graph, d, people, layout.topId) }
                if (layout.fresh.isNotEmpty() && layout.rest.isNotEmpty()) item("h-rest") { SectionHeading("Earlier notes", first = false) }
                items(layout.rest, key = { "r:" + it.id }) { d -> Card(graph, d, people, layout.topId) }
            }

            NewPill(
                count = state.pendingNewCount,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 10.dp),
            ) {
                controller.feed.applyPending()
                scope.launch { listState.animateScrollToItem(0) }
            }
        }
    }

    if (savedOpen) SavedSheet(graph, people, onDismiss = { savedOpen = false })

    if (openNoteId != null) {
        val linked = layout.all.firstOrNull { it.id == openNoteId }
        if (linked != null) NoteDetailSheet(graph, linked, people, onDismiss = onNoteOpened)
        else if (state.posts.isNotEmpty() && !state.loading) LaunchedEffect(openNoteId) { onNoteOpened() }
    }
}

@Composable
private fun Card(graph: AppGraph, d: today.cypherpunk.nalgorithm.ui.notes.DisplayPost, people: Map<String, today.cypherpunk.nalgorithm.model.ProfileData>, topId: String?) {
    NoteCard(
        graph, d.post, people,
        modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 10.dp),
        boostedBy = d.boostedBy,
        top = d.id == topId,
    )
}

@Composable
private fun FeedHeader(savedCount: Int, busy: Boolean, onSaved: () -> Unit, onRefresh: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = Nal.gutter, end = Nal.gutter, top = 20.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Feed", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f).semantics { heading() })
        if (savedCount > 0) NalButton("Saved · $savedCount", onSaved, kind = NalButtonKind.Ghost, small = true)
        NalButton("Refresh", onRefresh, kind = NalButtonKind.Primary, enabled = !busy, icon = Icons.Rounded.Refresh, busy = busy)
    }
}

@Composable
private fun StatusLine(text: String) {
    Text(
        text,
        style = NalText.status,
        color = Nal.colors.text2,
        modifier = Modifier.padding(horizontal = Nal.gutter).padding(bottom = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** "Updated 5 min ago" and, while a background run goes, a quiet spinner with what it is doing. */
@Composable
private fun MetaLine(age: String, busyText: String?) {
    val c = Nal.colors
    FlowRow(
        Modifier.fillMaxWidth().heightIn(min = 24.dp).padding(horizontal = Nal.gutter).padding(bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        if (age.isNotEmpty()) Text(age, color = c.text3, fontSize = 13.sp)
        if (busyText != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            ) {
                NalSpinner(size = 14.dp)
                Text(busyText, color = c.text2, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun SectionHeading(text: String, first: Boolean) {
    Text(
        text,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = if (first) 4.dp else 14.dp, bottom = 10.dp).semantics { heading() },
        color = if (first) Nal.colors.accentInk else Nal.colors.text3,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

/** The "N new notes" pill: floats over the list without taking room in it; a tap shows them and goes to the top. */
@Composable
private fun NewPill(count: Int, modifier: Modifier, onTap: () -> Unit) {
    val c = Nal.colors
    AnimatedVisibility(
        visible = count > 0,
        modifier = modifier,
        enter = fadeIn() + slideInVertically { -it / 2 },
        exit = fadeOut(),
    ) {
        val label = FeedLogic.pillLabel(count.coerceAtLeast(1))
        Button(
            onClick = onTap,
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent),
            contentPadding = PaddingValues(horizontal = 18.dp),
            modifier = Modifier.heightIn(min = 44.dp).shadow(12.dp, CircleShape).semantics { contentDescription = "$label. Show" },
        ) { Text(label, fontWeight = FontWeight.Bold, fontSize = 15.sp) }
    }
}

/** Shown once per identity, the first time a ranked feed is on screen (first-note.ts). */
@Composable
private fun FirstNoteCard(offerDigest: Boolean, onDigest: () -> Unit, onDone: () -> Unit) {
    val c = Nal.colors
    Column(
        Modifier
            .padding(horizontal = Nal.gutter)
            .padding(top = 4.dp, bottom = 12.dp)
            .fillMaxWidth()
            .border(1.dp, c.line, RoundedCornerShape(14.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(
            buildAnnotatedString {
                append("These are ranked against your words. Tap ")
                withStyle(SpanStyle(color = c.text, fontWeight = FontWeight.Bold)) { append("Why this?") }
                append(" on a note to see the match, or the ••• menu to steer it privately.")
            },
            color = c.text2,
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (offerDigest) NalButton("Try a digest", onDigest, small = true)
            NalButton("Got it", onDone, kind = NalButtonKind.Ghost, small = true)
        }
    }
}

/** Which identities have seen the first-ranking note. */
internal class FirstNoteStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun key(identity: String?) = "first_rank_note_${identity ?: "setup"}"
    fun seen(identity: String?): Boolean = prefs.getBoolean(key(identity), false)
    fun markSeen(identity: String?) { prefs.edit().putBoolean(key(identity), true).apply() }

    companion object { const val PREFS = "feed_prefs" }
}

/** Where the Feed tab is, so the shell can keep the list position across tabs. */
@Composable
fun rememberFeedListState(): LazyListState = androidx.compose.foundation.lazy.rememberLazyListState()

