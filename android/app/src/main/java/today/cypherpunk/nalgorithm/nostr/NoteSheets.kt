package today.cypherpunk.nalgorithm.nostr

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.theme.Nal

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ActionSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = Nal.colors.surface) {
        Column(
            Modifier
                .fillMaxWidth()
                .wrapContentWidth(Alignment.CenterHorizontally)
                .widthIn(max = Nal.column)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Nal.gutter)
                .padding(bottom = 24.dp)
                .navigationBarsPadding()
                .imePadding(),
            content = content,
        )
    }
}

/** The note being acted on, quoted (note-ui.ts quote()). */
@Composable
private fun QuotedNote(name: String, content: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Nal.colors.surface2, RoundedCornerShape(Nal.radiusSmall))
            .padding(12.dp),
    ) {
        Text(name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = Nal.colors.text)
        Text(
            content.trim().take(400).ifEmpty { "(no text)" },
            style = MaterialTheme.typography.bodyMedium,
            color = Nal.colors.text2,
            maxLines = 8,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * "Boost this note?" (note-ui.ts confirmBoost): asks for a signer first, then
 * confirms, then publishes through [NoteActions.boost], which reports in a toast.
 */
@Composable
fun BoostConfirmSheet(graph: AppGraph, post: ScoredPost, onDismiss: () -> Unit) {
    val actions = graph.noteActions
    val target = remember(post.id) { actions.targetOf(post) }
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(post.id) {
        if (actions.isBoosted(post)) {
            actions.boost(post) // says it was already boosted
            onDismiss()
            return@LaunchedEffect
        }
        if (actions.requireSigner() == null) onDismiss() else ready = true
    }
    if (!ready) return
    ActionSheet(onDismiss) {
        Text("Boost this note?", style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
        Spacer(Modifier.height(12.dp))
        Text("Your followers will see ${target.authorName}'s note as boosted by you.", style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text)
        Spacer(Modifier.height(10.dp))
        QuotedNote(target.authorName, target.content)
        Spacer(Modifier.height(10.dp))
        Text("A boost is public and cannot be taken back from here.", style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2)
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onDismiss) { Text("Cancel") }
            Spacer(Modifier.size(8.dp))
            Button(onClick = {
                onDismiss()
                graph.scope.launch { actions.boost(post) }
            }) { Text("Boost") }
        }
    }
}

/**
 * Write and send a reply (note-ui.ts replyToNote): the draft is kept per note
 * on this device, a signed reply is reused for a retry unless it was edited,
 * and the sheet says "Sent" at the first relay that takes it, then keeps counting.
 */
@Composable
fun ReplySheet(graph: AppGraph, post: ScoredPost, onDismiss: () -> Unit) {
    val actions = graph.noteActions
    val target = remember(post.id) { actions.targetOf(post) }
    val scope = rememberCoroutineScope()
    var signer by remember { mutableStateOf<NostrSigner?>(null) }
    var text by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var statusError by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var signed by remember { mutableStateOf<NoteActions.SignedReply?>(null) }
    var results by remember { mutableStateOf<List<RelayResult>?>(null) }
    var total by remember { mutableStateOf(0) }
    var done by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(post.id) {
        val s = actions.requireSigner()
        if (s == null) {
            onDismiss()
            return@LaunchedEffect
        }
        text = actions.loadDraft(s.pubkey, target.id).orEmpty()
        signer = s
    }
    val s = signer ?: return

    ActionSheet(onDismiss) {
        val sent = results
        if (sent != null && sent.any { it.ok }) {
            val ok = sent.count { it.ok }
            SentHeader("Sent", if (done || sent.size == total) NoteLogic.describePublish(sent) else "Published to $ok of $total relays so far…")
            RelayList(sent)
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { Button(onClick = onDismiss) { Text("Done") } }
            return@ActionSheet
        }
        Text("Reply to ${target.authorName}", style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
        Spacer(Modifier.height(12.dp))
        QuotedNote(target.authorName, target.content)
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it
                signed = null // an edit makes the signed event stale
                status = ""
                statusError = false
                actions.saveDraft(s.pubkey, target.id, it)
            },
            placeholder = { Text("Write your reply") },
            enabled = !busy,
            minLines = 5,
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .semantics { contentDescription = "Your reply to ${target.authorName}" },
        )
        val n = text.codePointCount(0, text.length)
        Text("$n ${if (n == 1) "character" else "characters"}", style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3, modifier = Modifier.padding(top = 4.dp))
        if (status.isNotEmpty()) {
            Text(
                status,
                style = MaterialTheme.typography.bodyMedium,
                color = if (statusError) Nal.colors.danger else Nal.colors.text2,
                modifier = Modifier.padding(top = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onDismiss) { Text("Cancel") }
            Spacer(Modifier.size(8.dp))
            Button(
                enabled = !busy && text.isNotBlank(),
                onClick = {
                    busy = true
                    statusError = false
                    scope.launch {
                        val fail = { message: String ->
                            busy = false
                            failed = true
                            status = message
                            statusError = true
                        }
                        try {
                            if (signed == null) {
                                status = "Waiting for your signer…"
                                signed = actions.signReply(s, target, text)
                            }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            fail("${e.message} Nothing was sent.")
                            return@launch
                        }
                        val ready = signed!!
                        total = ready.relays.size
                        status = "Publishing to $total ${if (total == 1) "relay" else "relays"}…"
                        var cleared = false
                        val all = actions.publishReply(ready) { _, soFar ->
                            // Optimistic: the first relay that takes it is enough to say Sent.
                            if (soFar.any { it.ok }) {
                                if (!cleared) {
                                    cleared = true
                                    actions.saveDraft(s.pubkey, target.id, "")
                                }
                                results = soFar
                            }
                        }
                        if (all.none { it.ok }) {
                            fail("No relay accepted your reply (0 of ${all.size}). ${actions.firstError(all)}".trim())
                            return@launch
                        }
                        results = all
                        done = true
                        busy = false
                    }
                },
            ) { Text(if (busy) "Sending…" else if (failed) "Retry" else "Send") }
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

@Composable
private fun RelayList(results: List<RelayResult>) {
    var open by remember { mutableStateOf(false) }
    Spacer(Modifier.height(12.dp))
    Text(
        if (open) "Relays ▾" else "Relays ▸",
        style = MaterialTheme.typography.labelLarge,
        color = Nal.colors.text2,
        modifier = Modifier.clickable { open = !open }.padding(vertical = 6.dp),
    )
    if (open) {
        for (r in results) {
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(r.relay.replace(Regex("^wss?://"), ""), style = MaterialTheme.typography.bodySmall, color = Nal.colors.text, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.size(8.dp))
                Text(
                    if (r.ok) "accepted" else "refused${r.error?.let { ": $it" }.orEmpty()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (r.ok) Nal.colors.accentInk else Nal.colors.danger,
                )
            }
        }
    }
}
