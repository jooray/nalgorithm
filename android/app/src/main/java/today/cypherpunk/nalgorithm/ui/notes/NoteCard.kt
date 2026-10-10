package today.cypherpunk.nalgorithm.ui.notes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.layout
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.nostr.Mark
import today.cypherpunk.nalgorithm.nostr.ZapSheet
import today.cypherpunk.nalgorithm.ui.theme.Nal

/**
 * One note as the feed renders it (render.ts): author, time, content with
 * mentions/links/media, quote or boost, score and reason, the action row and
 * the ••• private feedback menu. Tapping the card opens the detail sheet.
 *
 * [boostedBy] are the people whose boosts were folded into this card
 * ([aggregateBoosts]); [top] draws the lime edge of the best match.
 */
@Composable
fun NoteCard(
    graph: AppGraph,
    post: ScoredPost,
    profiles: Map<String, ProfileData>,
    modifier: Modifier = Modifier,
    showScore: Boolean = true,
    showActions: Boolean = true,
    boostedBy: List<String> = emptyList(),
    top: Boolean = false,
    detail: Boolean = true,
) {
    val c = Nal.colors
    val options = rememberNoteOptions(graph)
    val known by graph.profiles.profiles.collectAsState()
    val people = remember(profiles, known) { if (known.isEmpty()) profiles else known + profiles }
    var sheet by remember { mutableStateOf<NoteSheet?>(null) }
    val display = remember(post, boostedBy) { DisplayPost(post, boostedBy) }

    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Nal.radius))
            .background(c.surface)
            .drawBehind {
                if (top) {
                    // The top-ranked note: a lime edge, inset from the corners.
                    val w = 4.dp.toPx()
                    drawRoundRect(
                        c.accent,
                        topLeft = Offset(-w, 12.dp.toPx()),
                        size = Size(w * 2, size.height - 24.dp.toPx()),
                        cornerRadius = CornerRadius(w, w),
                    )
                }
            }
            .then(
                if (detail) Modifier.clickable(onClickLabel = "Open details", role = Role.Button) { sheet = NoteSheet.Detail(false) }
                else Modifier,
            )
            .padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = if (showActions) 4.dp else 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(post.author, people[post.author], options, size = 44, open = rememberLinkOpener(graph))
        Column(Modifier.weight(1f)) {
            NoteHead(graph, post, people, options)
            if (boostedBy.isNotEmpty()) BoostedByLine(graph, boostedBy, people, options)
            NoteBody(graph, post, people, options)
            if (showScore) ScoreRow(post, full = false, onWhy = if (detail) ({ sheet = NoteSheet.Detail(true) }) else null)
            if (showActions) ActionRow(graph, display, people, options, onSheet = { sheet = it }, menu = true)
        }
    }

    NoteSheets(graph, display, people, sheet, onSheet = { sheet = it })
}

/** Which sheet a note has open. */
sealed interface NoteSheet {
    data class Detail(val atWhy: Boolean) : NoteSheet
    data object Reply : NoteSheet
    data object Boost : NoteSheet
    data object Zap : NoteSheet
}

@Composable
internal fun NoteSheets(graph: AppGraph, display: DisplayPost, people: Map<String, ProfileData>, sheet: NoteSheet?, onSheet: (NoteSheet?) -> Unit) {
    when (sheet) {
        is NoteSheet.Detail -> NoteDetailSheet(graph, display, people, atWhy = sheet.atWhy, onDismiss = { onSheet(null) })
        NoteSheet.Reply -> today.cypherpunk.nalgorithm.nostr.ReplySheet(graph, display.post, onDismiss = { onSheet(null) })
        NoteSheet.Boost -> today.cypherpunk.nalgorithm.nostr.BoostConfirmSheet(graph, display.post, onDismiss = { onSheet(null) })
        NoteSheet.Zap -> ZapSheet(graph, display.post, onDismiss = { onSheet(null) })
        null -> Unit
    }
}

/** Name, handle, Boosted/Quoted and time on one line, as Primal, Damus and Amethyst set them. */
@Composable
internal fun NoteHead(graph: AppGraph, post: ScoredPost, people: Map<String, ProfileData>, options: NoteOptions) {
    val c = Nal.colors
    val open = rememberLinkOpener(graph)
    val profile = people[post.author]
    val label = authorLabel(post.author, profile)
    val handle = handleOf(profile)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                label.text,
                modifier = Modifier
                    .weight(1f, fill = false)
                    .clickable(onClickLabel = "Open profile", role = Role.Button) { open(options.profileHref(post.author)) },
                color = if (label.isNpub) c.text2 else c.text,
                fontWeight = if (label.isNpub) FontWeight.SemiBold else FontWeight.Bold,
                fontFamily = if (label.isNpub) androidx.compose.ui.text.font.FontFamily.Monospace else null,
                fontSize = if (label.isNpub) 14.sp else 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (handle.isNotEmpty()) {
                Text(handle, color = c.text3, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            if (post.type != today.cypherpunk.nalgorithm.model.PostType.Original) {
                Text(if (post.type == today.cypherpunk.nalgorithm.model.PostType.Boost) "Boosted" else "Quoted", color = c.text3, fontSize = 13.sp, maxLines = 1)
            }
        }
        val full = remember(post.createdAt) { NoteTime.full(post.createdAt) }
        Text(
            NoteTime.relative(post.createdAt),
            color = c.text3,
            fontSize = 14.sp,
            maxLines = 1,
            modifier = Modifier.semantics { contentDescription = full },
        )
    }
}

/** "Boosted by a, b, c and d", each name a profile link; long lists expand on demand. */
@Composable
internal fun BoostedByLine(graph: AppGraph, pubkeys: List<String>, people: Map<String, ProfileData>, options: NoteOptions) {
    val c = Nal.colors
    val open = rememberLinkOpener(graph)
    var expanded by remember { mutableStateOf(false) }
    val (shown, rest) = summarizeBoosters(pubkeys)
    val names = if (expanded || rest.isEmpty()) pubkeys else shown
    val text = androidx.compose.ui.text.buildAnnotatedString {
        append("Boosted by ")
        names.forEachIndexed { i, pk ->
            if (i > 0) append(if ((rest.isEmpty() || expanded) && i == names.size - 1) " and " else ", ")
            val l = authorLabel(pk, people[pk])
            val short = if (l.isNpub) l.text.take(16) + "…" else l.text
            withLink(
                androidx.compose.ui.text.LinkAnnotation.Clickable(
                    "p:$pk",
                    androidx.compose.ui.text.TextLinkStyles(androidx.compose.ui.text.SpanStyle(color = c.text2, fontWeight = FontWeight.SemiBold)),
                ) { open(options.profileHref(pk)) },
            ) { append(short) }
        }
        if (rest.isNotEmpty()) {
            append(" ")
            withLink(
                androidx.compose.ui.text.LinkAnnotation.Clickable(
                    "more",
                    androidx.compose.ui.text.TextLinkStyles(androidx.compose.ui.text.SpanStyle(color = c.accentInk)),
                ) { expanded = !expanded },
            ) { append(if (expanded) "fewer" else "and ${rest.size} more") }
        }
    }
    Text(text, color = c.text3, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 2.dp))
}

/** The lime score pill with the one-line reason beside it ([full]: the reason wraps, no "Why this?"). */
@Composable
internal fun ScoreRow(post: ScoredPost, full: Boolean, onWhy: (() -> Unit)?) {
    val c = Nal.colors
    Row(
        Modifier.padding(top = 12.dp).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = if (full) Alignment.Top else Alignment.CenterVertically,
    ) {
        val pill = if (post.defaultScore) "Not ranked yet" else "Score ${"%.1f".format(post.score)}"
        val pillLabel = if (post.defaultScore) "This note has not been ranked" else "Estimated relevance ${"%.1f".format(post.score)} out of 10"
        Text(
            pill,
            modifier = Modifier
                .clip(CircleShape)
                .background(c.accent)
                .padding(horizontal = 11.dp, vertical = 4.dp)
                .semantics { contentDescription = pillLabel },
            color = c.onAccent,
            fontSize = 13.sp,
            fontWeight = FontWeight.ExtraBold,
        )
        val reason = if (post.defaultScore) "Model unavailable. Refresh retries only unranked notes." else post.justification?.takeIf { it.isNotBlank() } ?: "No reason was given"
        Text(
            reason,
            modifier = Modifier.weight(1f).padding(top = if (full) 2.dp else 0.dp),
            color = c.text2,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = if (full) 21.sp else 20.sp,
            maxLines = if (full) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (!full && !post.defaultScore && onWhy != null) {
            Text(
                "Why this?",
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button, onClick = onWhy)
                    .heightIn(min = 32.dp)
                    .padding(horizontal = 4.dp, vertical = 6.dp),
                color = c.accentInk,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/** Reply, boost, like and zap, each a 44dp target; the ••• menu at the far end. */
@Composable
internal fun ActionRow(
    graph: AppGraph,
    display: DisplayPost,
    people: Map<String, ProfileData>,
    options: NoteOptions,
    onSheet: (NoteSheet) -> Unit,
    menu: Boolean,
) {
    val post = display.post
    val marks by graph.noteActions.marks.collectAsState()
    val mine = marks[post.id].orEmpty()
    val scope = rememberCoroutineScope()
    val toasts = graph.toasts
    // The icons line up with the text above them (.note-actions { margin-left: -12px }).
    Row(Modifier.padding(top = 4.dp).bleedStart(12.dp), verticalAlignment = Alignment.CenterVertically) {
        ActionIcon(Icons.AutoMirrored.Rounded.Reply, "Reply", on = false) { onSheet(NoteSheet.Reply) }
        ActionIcon(Icons.Rounded.Repeat, "Boost", on = Mark.Boosted in mine) {
            if (Mark.Boosted in mine) toasts.show("You boosted this. Nostr boosts cannot be taken back from here.")
            else onSheet(NoteSheet.Boost)
        }
        ActionIcon(if (Mark.Liked in mine) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, "Like", on = Mark.Liked in mine) {
            if (Mark.Liked in mine) {
                toasts.show("You liked this. Nostr likes cannot be taken back from here.")
                return@ActionIcon
            }
            // NoteActions reports success and failure itself (with Retry).
            scope.launch { graph.noteActions.like(post) }
        }
        ActionIcon(Icons.Rounded.Bolt, "Zap", on = Mark.Zapped in mine) { onSheet(NoteSheet.Zap) }
        if (menu) {
            Spacer(Modifier.weight(1f))
            NoteMenu(graph, display, people, options)
        }
    }
}

/** A failed public action: say why, and offer to try again. A cancelled signer request says nothing. */
internal fun reportFailure(graph: AppGraph, what: String, e: Throwable, retry: () -> Unit) {
    if (e is CancellationException) return
    val message = e.message?.trim().orEmpty()
    if (message.isEmpty()) return
    graph.toasts.show("$what: $message", actionLabel = "Retry", action = retry, isError = true)
}

@Composable
private fun ActionIcon(icon: ImageVector, label: String, on: Boolean, onClick: () -> Unit) {
    val c = Nal.colors
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .size(44.dp)
            .semantics { if (on) stateDescription = "Done" },
        colors = IconButtonDefaults.iconButtonColors(contentColor = if (on) c.accentInk else c.text2),
    ) { Icon(icon, contentDescription = label, modifier = Modifier.size(20.dp)) }
}

/** The ••• menu: private feedback first (none of it is published, each can be undone), then copy and open. */
@Composable
private fun NoteMenu(graph: AppGraph, display: DisplayPost, people: Map<String, ProfileData>, options: NoteOptions) {
    val c = Nal.colors
    val post = display.post
    val context = LocalContext.current
    val open = rememberLinkOpener(graph)
    val feedback by graph.feedback.state.collectAsState()
    var expanded by remember { mutableStateOf(false) }
    val toasts = graph.toasts
    val links = remember(post, options) { linksFor(post, options) }
    val who = authorLabel(post.author, people[post.author])
    val whoName = if (who.isNpub) "this person" else who.text
    val saved = feedback.saved.any { it.id == post.id }

    fun undoable(message: String, undo: (() -> Unit)?) {
        if (undo != null) toasts.undo(message, undo)
        else toasts.show("This note has no text to learn from.", isError = true)
    }

    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.size(44.dp)) {
            Icon(Icons.Rounded.MoreHoriz, contentDescription = "More actions", tint = c.text2, modifier = Modifier.size(20.dp))
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            containerColor = c.surface2,
            shape = RoundedCornerShape(Nal.radiusSmall),
            offset = DpOffset(0.dp, 0.dp),
        ) {
            Text(
                "Private, never published",
                modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 4.dp),
                color = c.text3,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            fun item(text: String, run: () -> Unit): @Composable () -> Unit = {
                DropdownMenuItem(
                    text = { Text(text, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = c.text) },
                    onClick = { expanded = false; run() },
                    modifier = Modifier.heightIn(min = 44.dp),
                )
            }
            item("More like this") {
                undoable("Noted privately: more like this. It steers future rankings.", graph.feedback.addRule(FeedbackRule.MORE, post))
            }()
            item("Less like this") {
                val undoRule = graph.feedback.addRule(FeedbackRule.LESS, post)
                val undoHide = graph.feedback.hideNote(post.id)
                // A note with no words still hides; there is just nothing for the ranking to learn.
                if (undoRule != null) undoable("Hidden, and noted privately: less like this.") { undoHide(); undoRule() }
                else undoable("Hidden. It has no text, so it does not steer rankings.", undoHide)
            }()
            item("Hide this note") { undoable("Note hidden on this device.", graph.feedback.hideNote(post.id)) }()
            item("Hide notes from $whoName") {
                undoable("Notes from $whoName are hidden on this device.", graph.feedback.muteAuthor(post.author))
            }()
            item(if (saved) "Remove from saved" else "Save for later") {
                if (graph.feedback.isSaved(post.id)) graph.feedback.unsaveNote(post.id)
                else undoable("Saved for later on this device. Find it under Saved in the feed.", graph.feedback.saveNote(post))
            }()
            HorizontalDivider(Modifier.padding(vertical = 4.dp), color = c.line)
            if (links.npub.isNotEmpty()) item("Copy npub") { Links.copy(context, links.npub, toasts) }()
            if (links.nprofile.isNotEmpty()) item("Copy nprofile") { Links.copy(context, links.nprofile, toasts) }()
            if (links.profileHref.isNotEmpty()) item("Open profile in ${options.clientLabel}") { open(links.profileHref) }()
            if (options.preset != ClientPreset.APP && links.npub.isNotEmpty()) {
                item("Open profile in my Nostr app (nostr: link)") { open(ClientUrl.nostrUri(links.nprofile.ifEmpty { links.npub })) }()
            }
            if (links.nevent.isNotEmpty()) {
                item("Copy note link (nevent)") { Links.copy(context, links.nevent, toasts) }()
                if (links.eventHref.isNotEmpty()) item("Open note in ${options.clientLabel}") { open(links.eventHref) }()
                if (options.preset != ClientPreset.APP) item("Open note in my Nostr app (nostr: link)") { open(ClientUrl.nostrUri(links.nevent)) }()
            }
        }
    }
}

/** Grow [amount] into the start padding of the parent, as a negative margin does. */
internal fun Modifier.bleedStart(amount: androidx.compose.ui.unit.Dp): Modifier = layout { measurable, constraints ->
    val extra = amount.roundToPx()
    val wide = if (constraints.hasBoundedWidth) constraints.copy(minWidth = constraints.maxWidth + extra, maxWidth = constraints.maxWidth + extra) else constraints
    val p = measurable.measure(wide)
    val w = if (constraints.hasBoundedWidth) constraints.maxWidth else p.width - extra
    layout(w, p.height) { p.place(-extra, 0) }
}
