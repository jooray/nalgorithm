package today.cypherpunk.nalgorithm.ui.notes

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.nostr.Filter
import today.cypherpunk.nalgorithm.ui.theme.FormStatus
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.theme.NalButton
import today.cypherpunk.nalgorithm.ui.theme.NalButtonKind
import today.cypherpunk.nalgorithm.ui.theme.NalSheet
import today.cypherpunk.nalgorithm.ui.theme.NalSpinner
import today.cypherpunk.nalgorithm.ui.theme.NalTextField
import today.cypherpunk.nalgorithm.ui.theme.QuoteBox

// ─── Detail ──────────────────────────────────────────────────────────────────

/** A note from a relay as the detail sheet draws it, without a ranking. */
internal fun unrankedPost(ev: NostrEvent): ScoredPost =
    ScoredPost(id = ev.id, type = PostType.Original, author = ev.pubkey, content = ev.content, createdAt = ev.createdAt, score = Double.NaN, rawEvent = ev)

/**
 * The full note, its actions, what it replies to and its direct replies (one
 * level each way), why it ranked, and every way to open or copy it.
 */
@Composable
fun NoteDetailSheet(graph: AppGraph, display: DisplayPost, profiles: Map<String, ProfileData>, atWhy: Boolean = false, onDismiss: () -> Unit) {
    // Opening a parent or a reply shows it here in full, as the web opens a new sheet over the old one.
    var current by remember(display) { mutableStateOf(display) }
    var whyFirst by remember(display) { mutableStateOf(atWhy) }
    NalSheet(title = "Note", onDismiss = onDismiss) {
        DetailBody(graph, current, profiles, whyFirst) { ev ->
            current = DisplayPost(unrankedPost(ev))
            whyFirst = false
        }
    }
}

private data class ThreadState(val loading: Boolean = true, val parent: NostrEvent? = null, val replies: List<NostrEvent> = emptyList())

@Composable
private fun DetailBody(graph: AppGraph, display: DisplayPost, profiles: Map<String, ProfileData>, atWhy: Boolean, openEvent: (NostrEvent) -> Unit) {
    val c = Nal.colors
    val post = display.post
    val options = rememberNoteOptions(graph)
    val known by graph.profiles.profiles.collectAsState()
    val people = remember(profiles, known) { known + profiles }
    var sheet by remember(post.id) { mutableStateOf<NoteSheet?>(null) }
    val thread by androidx.compose.runtime.produceState(ThreadState(), post.id) { value = loadThread(graph, post) }
    val whyRequester = remember { BringIntoViewRequester() }
    val ranked = !post.score.isNaN()

    if (thread.parent != null) {
        SheetSectionTitle("In reply to")
        CompactNote(graph, thread.parent!!, people, options) { openEvent(thread.parent!!) }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
        Avatar(post.author, people[post.author], options, size = 44, open = rememberLinkOpener(graph))
        Column(Modifier.weight(1f)) {
            NoteHead(graph, post, people, options)
            if (display.boostedBy.isNotEmpty()) BoostedByLine(graph, display.boostedBy, people, options)
            NoteBody(graph, post, people, options)
        }
    }
    Box(Modifier.padding(top = 6.dp)) { ActionRow(graph, display, people, options, onSheet = { sheet = it }, menu = false) }

    if (ranked) {
        Column(Modifier.bringIntoViewRequester(whyRequester).padding(top = 18.dp)) {
            SheetSectionTitle("Why it ranked")
            ScoreRow(post, full = true, onWhy = null)
            Text(
                if (post.defaultScore) "The model could not score this note, so it sits behind the ranked ones."
                else "The score estimates how well this note matches your words in Tune; it is the model's judgement, not a measured certainty. The model read the first 500 characters of the note. To change what ranks high, change your words.",
                color = c.text2, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 8.dp),
            )
        }
        LaunchedEffect(atWhy, post.id) {
            if (atWhy) { delay(250); whyRequester.bringIntoView() }
        }
    }

    Column(Modifier.padding(top = 18.dp)) {
        val replies = thread.replies
        SheetSectionTitle(if (thread.loading || replies.isEmpty()) "Replies" else "Replies (${replies.size}${if (replies.size == 20) ", oldest first" else ""})")
        when {
            thread.loading -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                NalSpinner(); Text("Loading replies…", color = c.text2, fontSize = 14.sp)
            }
            replies.isEmpty() -> Text("No replies found on your relays.", color = c.text2, fontSize = 14.sp)
            else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (r in replies) CompactNote(graph, r, people, options) { openEvent(r) }
            }
        }
    }

    SheetActions(graph, post, options)
    NoteSheets(graph, display, people, sheet, onSheet = { sheet = it })
}

private suspend fun loadThread(graph: AppGraph, post: ScoredPost): ThreadState = kotlinx.coroutines.coroutineScope {
    val relays = runCatching { graph.active?.relays().orEmpty() }.getOrDefault(emptyList())
    if (relays.isEmpty()) return@coroutineScope ThreadState(loading = false)
    val raw = post.rawEvent
    val parent = async {
        runCatching {
            val self = if (raw != null && raw.sig.isNotEmpty()) raw else graph.relayPool.get(relays, Filter(ids = listOf(post.id)))
            val ref = self?.let(Thread::parentOf) ?: return@runCatching null
            graph.relayPool.get(listOfNotNull(ref.relay) + relays, Filter(ids = listOf(ref.id)))
        }.getOrNull()
    }
    val replies = async {
        runCatching {
            Thread.directReplies(graph.relayPool.query(relays, listOf(Filter(kinds = listOf(1), e = listOf(post.id), limit = 100))), post.id, 20)
        }.getOrDefault(emptyList())
    }
    val p = parent.await()
    val r = replies.await()
    val people = (listOfNotNull(p?.pubkey) + r.map { it.pubkey }).distinct()
    if (people.isNotEmpty()) graph.scope.launch { runCatching { graph.profiles.load(people, relays) } }
    ThreadState(loading = false, parent = p, replies = r)
}

@Composable
private fun SheetSectionTitle(text: String) {
    Text(
        text,
        modifier = Modifier.padding(top = 4.dp, bottom = 8.dp).semantics { heading() },
        color = Nal.colors.text3,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

/** A smaller note for a parent or a reply. Tapping it opens it in full. */
@Composable
private fun CompactNote(graph: AppGraph, ev: NostrEvent, people: Map<String, ProfileData>, options: NoteOptions, onOpen: () -> Unit) {
    val c = Nal.colors
    val post = remember(ev) { unrankedPost(ev) }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Nal.radiusSmall))
            .background(c.surface2)
            .clickable(onClickLabel = "Open", role = Role.Button, onClick = onOpen)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Avatar(ev.pubkey, people[ev.pubkey], options, size = 32)
        Column(Modifier.weight(1f)) {
            NoteHead(graph, post, people, options)
            ContentText(ev.content, people, options, rememberLinkOpener(graph), Modifier.padding(top = 4.dp), fontSize = 15, maxLines = 6)
        }
    }
}

@Composable
private fun SheetActions(graph: AppGraph, post: ScoredPost, options: NoteOptions) {
    val context = LocalContext.current
    val open = rememberLinkOpener(graph)
    val links = remember(post, options) { linksFor(post, options) }
    Column(Modifier.padding(top = 18.dp)) {
        HorizontalDivider(color = Nal.colors.line)
        if (links.nevent.isNotEmpty()) CopyAction("Copy note link (nevent)") { Links.copy(context, links.nevent) }
        if (links.eventHref.isNotEmpty()) SheetAction("Open note in ${options.clientLabel}", Icons.AutoMirrored.Rounded.OpenInNew) { open(links.eventHref) }
        if (options.preset != ClientPreset.APP && links.nevent.isNotEmpty()) {
            SheetAction("Open note in my Nostr app", Icons.AutoMirrored.Rounded.OpenInNew) { open(ClientUrl.nostrUri(links.nevent)) }
        }
        if (links.npub.isNotEmpty()) CopyAction("Copy npub") { Links.copy(context, links.npub) }
        if (links.profileHref.isNotEmpty()) SheetAction("Open profile in ${options.clientLabel}", Icons.Rounded.Person) { open(links.profileHref) }
    }
}

/** A copy row that says "Copied" (or "Copy failed") in place for a moment, as the web does. */
@Composable
private fun CopyAction(label: String, copy: () -> Boolean) {
    var result by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(result) { if (result != null) { delay(1400); result = null } }
    SheetAction(
        when (result) { true -> "Copied"; false -> "Copy failed"; null -> label },
        if (result == true) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
    ) { result = copy() }
}

@Composable
private fun SheetAction(label: String, icon: ImageVector, onClick: () -> Unit) {
    val c = Nal.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = c.text2, modifier = Modifier.size(20.dp))
        Text(label, color = c.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}
