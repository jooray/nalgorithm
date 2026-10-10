package today.cypherpunk.nalgorithm.ui.tune

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.data.DeviceSettings
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.ui.notes.ClientPreset
import today.cypherpunk.nalgorithm.ui.notes.ClientUrl
import today.cypherpunk.nalgorithm.ui.notes.shortName
import today.cypherpunk.nalgorithm.ui.theme.FieldHint
import today.cypherpunk.nalgorithm.ui.theme.FieldLabel
import today.cypherpunk.nalgorithm.ui.theme.FormStatus
import today.cypherpunk.nalgorithm.ui.theme.LinkButton
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.theme.NalButton
import today.cypherpunk.nalgorithm.ui.theme.NalButtonKind
import today.cypherpunk.nalgorithm.ui.theme.NalCheck
import today.cypherpunk.nalgorithm.ui.theme.NalChip
import today.cypherpunk.nalgorithm.ui.theme.NalSelect
import today.cypherpunk.nalgorithm.ui.theme.NalTextField
import today.cypherpunk.nalgorithm.ui.theme.SectionTitle
import today.cypherpunk.nalgorithm.ui.theme.StateCard

/** A titled Tune card (web `.tune-section`): a hairline on top, the title, then the fields. */
@Composable
fun TuneSection(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth()) {
        HorizontalDivider(color = Nal.colors.line)
        Column(Modifier.fillMaxWidth().padding(start = Nal.gutter, end = Nal.gutter, top = 24.dp, bottom = 28.dp)) {
            SectionTitle(title)
            Column(Modifier.padding(top = 2.dp), content = content)
        }
    }
}

/**
 * Prompt textarea with character count and the prompt starters (prompt-starters.ts).
 * [maxChars] caps what can be typed; `Int.MAX_VALUE` means no cap (BYOK).
 */
@Composable
fun PromptField(value: String, onValueChange: (String) -> Unit, maxChars: Int, modifier: Modifier = Modifier, label: String = "In your own words") {
    val capped = maxChars in 1 until Int.MAX_VALUE
    Column(modifier.fillMaxWidth()) {
        FieldLabel(label)
        NalTextField(
            value = value,
            onValueChange = { onValueChange(if (capped) it.take(maxChars) else it) },
            placeholder = PromptStarters.PLACEHOLDER,
            singleLine = false,
            minLines = 6,
            contentDescription = label,
        )
        FieldHint(
            if (capped) "${value.length} / $maxChars characters" else "${value.length} characters",
            align = TextAlign.End,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        FieldHint("Use your own words; you can change this later. Starters:")
        FlowRow(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (text in PromptStarters.STARTERS) {
                NalChip("+ $text", onClick = {
                    PromptStarters.add(value, text, if (capped) maxChars else 0)?.let(onValueChange)
                }, contentDescription = "Add “$text” to your words")
            }
        }
    }
}

/** prompt-starters.ts: a few editable phrases for a reader facing an empty box. Nothing is inferred. */
object PromptStarters {
    val STARTERS = listOf(
        "Bitcoin and Lightning development",
        "Privacy and security tools",
        "Thoughtful longform posts",
        "Not: price talk, GM posts or ads",
    )
    const val PLACEHOLDER = "I like cypherpunk culture, decentralized technology, Bitcoin, and thoughtful longform posts. I don't care about price speculation or GM posts."

    /** The prompt with [starter] added, or null when it is already there or would not fit in [max] (0 = no cap). */
    fun add(current: String, starter: String, max: Int): String? {
        val now = current.trim()
        if (now.lowercase().contains(starter.lowercase())) return null
        val joined = if (now.isNotEmpty()) "${now.replaceFirst(Regex("[.,;]?$"), ".")} $starter." else "$starter."
        if (max > 0 && joined.length > max) return null
        return joined
    }
}

/** "Reading and listening": feed order, data saver, digest length, cache audio + remove cached audio. */
@Composable
fun ReadingAndListeningSection(graph: AppGraph) {
    val s by graph.deviceSettings.settings.collectAsState()
    val cacheStatus by graph.audio.cacheStatus.collectAsState()
    val scope = rememberCoroutineScope()
    var cleared by remember { mutableStateOf<String?>(null) }
    TuneSection("Reading and listening") {
        FieldLabel("Feed order")
        NalSelect(
            options = listOf("new" to "New arrivals first", "best" to "Best relevance first"),
            selected = s.feedOrder,
            onSelect = { v -> graph.deviceSettings.update { it.copy(feedOrder = v) } },
            label = "Feed order",
        )
        NalCheck(
            checked = s.dataSaver,
            onCheckedChange = { v -> graph.deviceSettings.update { it.copy(dataSaver = v) } },
            title = "Tap to load remote media",
            small = "Saves data and avoids contacting image hosts until you choose to load an image.",
        )
        FieldLabel("Target digest length")
        NalSelect(
            options = DeviceSettings.DIGEST_MINUTES.map { it.toString() to "About $it minutes" },
            selected = s.digestMinutes.toString(),
            onSelect = { v -> graph.deviceSettings.update { it.copy(digestMinutes = v.toInt()) } },
            label = "Target digest length",
        )
        NalCheck(
            checked = s.cacheAudio,
            onCheckedChange = { v -> graph.deviceSettings.update { it.copy(cacheAudio = v) } },
            title = "Keep the newest three digests offline",
            small = "Up to 30 MB on this device. Download MP3 keeps an independent copy.",
        )
        val status = cleared ?: cacheStatus
        if (!status.isNullOrEmpty()) FieldHint(status, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        NalButton("Remove cached audio", {
            scope.launch {
                runCatching { graph.audio.clearCache() }
                cleared = "Cached audio removed. Downloads you saved outside the app are unchanged."
            }
        }, Modifier.padding(top = 12.dp), small = true)
    }
}

/** "Private feedback": rules, muted people, hidden notes, each undoable (feedback-ui.ts). */
@Composable
fun PrivateFeedbackSection(graph: AppGraph) {
    val state by graph.feedback.state.collectAsState()
    val mode by graph.modeStore.mode.collectAsState()
    val known by graph.profiles.profiles.collectAsState()
    TuneSection("Private feedback") {
        FieldHint(
            "From the ••• menu on a note. It stays on this device and is never published. More and Less like this also steer future rankings" +
                (if (mode == AppMode.Hosted) ", so they are sent to the server with your settings" else "") +
                ". Public likes are separate.",
            Modifier.padding(top = 6.dp),
        )
        for (r in state.rules) {
            FeedbackRow("${if (r.kind == "more") "More" else "Less"} like “${r.excerpt}”", "Remove") {
                val undo = graph.feedback.removeRule(r.noteId)
                graph.toasts.undo("Feedback removed. It no longer steers rankings.", undo)
            }
        }
        for (pk in state.muted) {
            val name = shortName(pk, known[pk])
            FeedbackRow("Notes from $name are hidden.", "Show them") { graph.feedback.unmuteAuthor(pk) }
        }
        if (state.hidden.isNotEmpty()) {
            FeedbackRow("${if (state.hidden.size == 1) "1 note is" else "${state.hidden.size} notes are"} hidden.", "Show them again") {
                val undo = graph.feedback.showHiddenNotes()
                graph.toasts.undo("Hidden notes are back in your feed.", undo)
            }
        } else if (state.rules.isEmpty() && state.muted.isEmpty()) {
            FieldHint("Nothing yet.")
        }
    }
}

@Composable
private fun FeedbackRow(text: String, action: String, run: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f).padding(end = 8.dp), color = Nal.colors.text, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
        LinkButton(action, run)
    }
}

/** "Open notes in": the client picker (client-url.ts), with custom templates checked as they are typed. */
@Composable
fun OpenNotesInSection(graph: AppGraph) {
    val s by graph.deviceSettings.settings.collectAsState()
    // Typed text is kept as typed; only an allowed template is ever used for a link (resolveTemplate).
    var custom by rememberSaveable { mutableStateOf(s.clientCustomUrl) }
    var customProfile by rememberSaveable { mutableStateOf(s.clientCustomProfileUrl) }
    TuneSection("Open notes in") {
        FieldLabel("Nostr client")
        NalSelect(
            options = ClientPreset.OPTIONS,
            selected = s.clientPreset,
            onSelect = { v -> graph.deviceSettings.update { it.copy(clientPreset = v) } },
            label = "Nostr client",
        )
        if (s.clientPreset == ClientPreset.CUSTOM) {
            val postError = ClientUrl.validateTemplate(custom)
            val profileError = ClientUrl.validateTemplate(customProfile)
            NalTextField(
                value = custom,
                onValueChange = { v -> custom = v; graph.deviceSettings.update { it.copy(clientCustomUrl = v.trim()) } },
                modifier = Modifier.padding(top = 10.dp),
                placeholder = "https://example.com/e/{e}",
                isError = postError != null,
                mono = true,
                contentDescription = "Custom post link template",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )
            if (postError != null) FormStatus("Post links: $postError", error = true)
            NalTextField(
                value = customProfile,
                onValueChange = { v -> customProfile = v; graph.deviceSettings.update { it.copy(clientCustomProfileUrl = v.trim()) } },
                modifier = Modifier.padding(top = 10.dp),
                placeholder = "https://example.com/p/{npub}",
                isError = profileError != null,
                mono = true,
                contentDescription = "Custom profile link template",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )
            if (profileError != null) FormStatus("Profile links: $profileError", error = true)
            FieldHint("Post links use {e} for the nevent; profile links use {npub}, {nprofile} or {pubkey}. Or give just a prefix. Only http, https and nostr: links are accepted.")
        }
    }
}

/**
 * "Privacy and this device": export settings, disconnect signer, clear this
 * device; [extra] is mode-specific (hosted: export account, delete account).
 *
 * [modeSettings] gives the mode's own settings for the export (BYOK: everything in
 * Tune, the model key only when asked); with it, the "include my model key" box is
 * offered. [beforeClear] runs before this device is wiped (hosted: sign out).
 */
@Composable
fun DeviceSection(
    graph: AppGraph,
    extra: @Composable ColumnScope.() -> Unit = {},
    modeSettings: ((includeKey: Boolean) -> JsonElement)? = null,
    beforeClear: suspend () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val mode by graph.modeStore.mode.collectAsState()
    val hosted = mode == AppMode.Hosted
    var includeKey by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var clearing by remember { mutableStateOf(false) }
    val offerKey = !hosted && modeSettings != null
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val withKey = offerKey && includeKey
        scope.launch {
            val ok = runCatching {
                val text = DeviceData.exportJson(graph, mode, if (hosted) null else modeSettings?.invoke(withKey))
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray()) }
                }
            }.isSuccess
            status = if (!ok) "The file could not be written. Try another place." to true
            else (if (withKey) "Exported, including your model key. Keep the file private." else "Exported without your model key or signer secrets.") to false
        }
    }

    TuneSection("Privacy and this device") {
        FieldHint(
            if (hosted) {
                "Our server keeps your settings, words, learned taste, scores, rankings, digests and private more/less feedback to run the service, and sends the notes' text to the model provider it uses to rank them and write digests. Digest audio is uploaded to public file hosts: anyone with the link can play it. Link previews are fetched by the server. Payments are handled by a separate billing service. This phone keeps a copy of your ranking and digests for offline use."
            } else {
                "Your settings, model key, rankings, digests, cached audio and private feedback stay on this phone. The text of the notes being ranked goes from this phone to the model provider you chose. Relays you list supply the notes. Images and avatars load from their own hosts unless Tap to load remote media is on. Replies, boosts, likes and zaps are signed by your signer and published to relays."
            },
            Modifier.padding(top = 6.dp),
        )
        if (offerKey) {
            NalCheck(includeKey, { includeKey = it }, "Include my model API key in the export", small = "Anyone with the file could use the key.")
        }
        FlowRow(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            NalButton("Export settings", { export.launch("nalgorithm-settings-${DeviceData.today()}.json") }, small = true)
            NalButton("Disconnect signer", {
                graph.signers.forget()
                status = "This device no longer keeps a signer connection. To revoke the permission in the signer itself, remove this app there (in Amber: Applications)." to false
            }, small = true)
        }
        FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            NalButton("Clear all data on this device", { confirming = true }, kind = NalButtonKind.Danger, small = true)
        }
        extra()
        if (confirming) {
            StateCard(Modifier.padding(top = 12.dp), error = true) {
                Text(
                    "This removes your settings, keys, signer connection, rankings, digests, cached audio and private feedback from this phone, and restarts the app. " +
                        if (hosted) "It also signs you out. Your hosted account, digests on the server, audio already on public file hosts and payment records stay."
                        else "Audio or notes already published elsewhere stay.",
                    color = Nal.colors.text,
                )
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    NalButton("Clear this device", {
                        clearing = true
                        scope.launch {
                            try {
                                runCatching { beforeClear() }
                                DeviceData.clear(graph)
                                DeviceData.restart(context)
                            } catch (e: Exception) {
                                status = (e.message ?: "This device could not be cleared.") to true
                                confirming = false
                                clearing = false
                            }
                        }
                    }, kind = NalButtonKind.Danger, small = true, enabled = !clearing)
                    NalButton("Cancel", { confirming = false }, kind = NalButtonKind.Ghost, small = true, enabled = !clearing)
                }
            }
        }
        status?.let { (text, error) -> FormStatus(text, error = error) }
    }
}
