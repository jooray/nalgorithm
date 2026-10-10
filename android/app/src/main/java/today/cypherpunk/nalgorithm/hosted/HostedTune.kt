package today.cypherpunk.nalgorithm.hosted

import android.app.TimePickerDialog
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import android.content.ClipData
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.BuildConfig
import today.cypherpunk.nalgorithm.data.DeviceSettings
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.tune.DeviceSection
import today.cypherpunk.nalgorithm.ui.tune.OpenNotesInSection
import today.cypherpunk.nalgorithm.ui.tune.PrivateFeedbackSection
import today.cypherpunk.nalgorithm.ui.tune.PromptField
import today.cypherpunk.nalgorithm.ui.tune.ReadingAndListeningSection
import today.cypherpunk.nalgorithm.ui.tune.TuneSection
import today.cypherpunk.nostrsignin.Bech32
import java.time.LocalDate

/** The hosted Tune tab, as the web's `#tune-hosted` followed by the sections both modes share. */
@Composable
internal fun HostedTune(c: HostedController, modifier: Modifier) {
    val scroll = rememberScrollState()
    val focus by c.focusPrompt.collectAsState()
    val promptFocus = remember { FocusRequester() }
    var promptY by remember { mutableIntStateOf(0) }
    LaunchedEffect(focus) {
        if (focus == 0) return@LaunchedEffect
        scroll.animateScrollTo(promptY)
        runCatching { promptFocus.requestFocus() }
    }
    DisposableEffect(Unit) { onDispose { c.voiceSample.stop() } }

    CappedColumn(modifier.verticalScroll(scroll)) {
        Column(Modifier.padding(horizontal = Nal.gutter, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            AccountSection(c)
            Box(Modifier.onGloballyPositioned { promptY = it.positionInParent().y.toInt() }) { PromptSection(c, promptFocus) }
            FeedSection(c)
            DigestSection(c)
            ReadingAndListeningSection(c.graph)
            PrivateFeedbackSection(c.graph)
            OpenNotesInSection(c.graph)
            DeviceSection(c.graph, extra = { HostedDeviceExtra(c) }, beforeClear = { c.signOut() })
            SaveArea(c)
            ThisDeviceSection(c)
        }
    }
}

/** npub1abcdefghij…uvwxyz, as the web shortens a long identity. */
internal fun shortNpub(hex: String?): String {
    val npub = hex?.let { runCatching { Bech32.npub(it) }.getOrNull() } ?: return ""
    return if (npub.length > 24) "${npub.take(14)}…${npub.takeLast(6)}" else npub
}

@Composable
private fun CheckRow(checked: Boolean, label: String, small: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 4.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Checkbox(checked = checked, onCheckedChange = onChange)
        Column(Modifier.padding(top = 12.dp)) {
            Text(label, color = Nal.colors.text)
            Text(small, style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
        }
    }
}

@Composable
private fun AccountSection(c: HostedController) {
    val reader by c.reader.collectAsState()
    val ent by c.entitlement.collectAsState()
    TuneSection("Account") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(Nal.colors.accent, CircleShape))
            Text("Signed in", modifier = Modifier.padding(horizontal = 8.dp), color = Nal.colors.text2)
            Text(shortNpub(reader), fontFamily = FontFamily.Monospace, color = Nal.colors.text, style = MaterialTheme.typography.bodySmall)
        }
        ent?.let { Text(entitlementView(it, System.currentTimeMillis() / 1000).text, modifier = Modifier.padding(top = 8.dp), color = Nal.colors.text) }
        Button(onClick = { c.showPaywall() }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) { Text("Subscribe or add time") }
    }
}

@Composable
private fun PromptSection(c: HostedController, focus: FocusRequester) {
    val form by c.form.collectAsState()
    val firstRun by c.firstRunHint.collectAsState()
    TuneSection("What you care about") {
        PromptField(
            value = form.prompt,
            onValueChange = { v -> c.edit(false) { it.copy(prompt = v.take(MAX_PROMPT_CHARS)) } },
            maxChars = MAX_PROMPT_CHARS,
            modifier = Modifier.focusRequester(focus),
            label = "Your words (the ranking rule)",
        )
        if (firstRun) Hint("Ranking your feed and writing your first digest start as soon as you save this.")
    }
}

@Composable
private fun NumberField(value: String, label: String, modifier: Modifier, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.filter { ch -> ch.isDigit() }.take(3)) },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = modifier,
    )
}

@Composable
private fun FeedSection(c: HostedController) {
    val form by c.form.collectAsState()
    val learned by c.learnedText.collectAsState()
    val learnedStatus by c.learnedStatus.collectAsState()
    TuneSection("Feed") {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            NumberField(form.hours, "Hours back (1 to 72)", Modifier.weight(1f)) { v -> c.edit(false) { it.copy(hours = v) } }
            NumberField(form.topN, "Posts in digest (1 to 30)", Modifier.weight(1f)) { v -> c.edit(false) { it.copy(topN = v) } }
        }
        CheckRow(form.learn, "Learn from my likes", "Off ranks using only your written interests. Your learned taste is kept for re-enabling.") { v ->
            c.edit(false) { it.copy(learn = v) }
        }
        OutlinedTextField(
            value = learned,
            onValueChange = {},
            readOnly = true,
            label = { Text("Learned from your likes") },
            placeholder = { Text("Nothing learned yet. It builds up from notes you like.") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        )
        TextButton(onClick = c::resetLearned) { Text("Reset learned taste") }
        StatusText(learnedStatus)
        CheckRow(
            form.previews,
            "Show link previews",
            "Previews are fetched by the server, not by your phone: the sites do not see you, but the server does see which links you look at. Off shows plain links only.",
        ) { v -> c.edit(false) { it.copy(previews = v) } }
    }
}

/** A labelled choice from a list, like a `<select>`; entries with a null value are group headings. */
@Composable
private fun Picker(label: String, current: String, options: List<Pair<String?, String>>, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = Nal.colors.text2)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                Text(options.firstOrNull { it.first == current }?.second ?: current, modifier = Modifier.weight(1f), color = Nal.colors.text)
                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for ((value, text) in options) {
                    if (value == null) {
                        Text(text, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium, color = Nal.colors.text3)
                    } else {
                        DropdownMenuItem(text = { Text(text) }, onClick = {
                            open = false
                            onPick(value)
                        })
                    }
                }
            }
        }
    }
}

private val VOICE_OPTIONS: List<Pair<String?, String>> = buildList {
    add("" to "Default")
    add(null to "With a sample")
    for (id in SAMPLE_VOICE_IDS) DIGEST_VOICES.firstOrNull { it.id == id }?.let { add(it.id to it.label) }
    add(null to "More voices")
    for (v in DIGEST_VOICES) if (v.id !in SAMPLE_VOICE_IDS) add(v.id to v.label)
}

private data class ClientInfo(val label: String, val profileUrl: String)

private val CLIENTS = mapOf(
    "njump" to ClientInfo("njump", "https://njump.me/{npub}"),
    "primal" to ClientInfo("Primal", "https://primal.net/p/{npub}"),
    "yakihonne" to ClientInfo("Yakihonne", "https://yakihonne.com/profile/{npub}"),
    "app" to ClientInfo("my Nostr app", "nostr:{npub}"),
)

private val ALLOWED_SCHEMES = setOf("http", "https", "nostr", "web+nostr")

private fun allowedLink(url: String): Boolean {
    if (url.trim() != url || url.any { it.code <= 0x20 || it.code in 0x7f..0x9f }) return false
    val scheme = Regex("^([a-z][a-z0-9+.-]*):", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1)?.lowercase() ?: return false
    return scheme in ALLOWED_SCHEMES
}

/** The digest account in the reader's chosen client (client-url.ts buildProfileUrl), njump when the template does not work. */
internal fun botProfileLink(s: DeviceSettings): Pair<String, String> {
    val hex = Bech32.pubkeyHex(DIGEST_BOT_NPUB)!!
    val nprofile = Bech32.encode("nprofile", byteArrayOf(0, 32) + hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
    val values = mapOf("npub" to DIGEST_BOT_NPUB, "nprofile" to nprofile, "pubkey" to hex)
    val custom = s.clientPreset == "custom"
    val template = if (custom) s.clientCustomProfileUrl.trim() else CLIENTS[s.clientPreset]?.profileUrl ?: CLIENTS.getValue("njump").profileUrl
    val label = if (custom) "client" else CLIENTS[s.clientPreset]?.label ?: "njump"
    val filled = when {
        template.isEmpty() -> ""
        Regex("\\{[a-z]+\\}", RegexOption.IGNORE_CASE).containsMatchIn(template) ->
            template.replace(Regex("\\{([a-z]+)\\}", RegexOption.IGNORE_CASE)) { m -> values[m.groupValues[1]] ?: m.value }
        template.endsWith(":") || Regex("^[a-z][a-z0-9+.-]*:[^/]*$", RegexOption.IGNORE_CASE).matches(template) -> template + DIGEST_BOT_NPUB
        else -> template.trimEnd('/') + "/" + DIGEST_BOT_NPUB
    }
    val url = filled.takeIf { it.isNotEmpty() && allowedLink(it) } ?: "https://njump.me/$DIGEST_BOT_NPUB"
    return url to "open the digest account in $label"
}

@Composable
private fun DigestSection(c: HostedController) {
    val form by c.form.collectAsState()
    val device by c.graph.deviceSettings.settings.collectAsState()
    val scheduleStatus by c.scheduleStatus.collectAsState()
    val lastStatus by c.lastStatusLine.collectAsState()
    val nowStatus by c.nowStatus.collectAsState()
    val savingSchedule by c.savingSchedule.collectAsState()
    val digests by c.digests.state.collectAsState()
    val sampleStatus by c.voiceSample.status.collectAsState()
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copyLabel by remember { mutableStateOf("Copy npub") }
    var zonePicker by remember { mutableStateOf(false) }

    TuneSection("Daily voice digest") {
        Hint(DIGEST_DM_NOTE)
        val (botUrl, botLabel) = botProfileLink(device)
        Hint("Sent by the digest account. Follow it so your app shows the messages:")
        TextButton(onClick = { runCatching { uri.openUri(botUrl) } }) { Text(botLabel) }
        Text("or copy its npub:", style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
        Text(DIGEST_BOT_NPUB, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = Nal.colors.text, modifier = Modifier.padding(vertical = 4.dp))
        OutlinedButton(onClick = {
            scope.launch {
                val copied = runCatching { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("npub", DIGEST_BOT_NPUB))) }.isSuccess
                copyLabel = if (copied) "Copied" else "Select the npub to copy"
                delay(2000)
                copyLabel = "Copy npub"
            }
        }) { Text(copyLabel) }

        CheckRow(
            form.digestEnabled,
            "Send me a digest every day",
            "Off by default. The DM is encrypted, but the audio file it links to is uploaded to public file hosts: anyone who has the link can play it.",
        ) { v -> c.edit(true) { it.copy(digestEnabled = v) } }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                Text("Time of day", style = MaterialTheme.typography.labelLarge, color = Nal.colors.text2)
                OutlinedButton(onClick = {
                    val (h, m) = form.digestTime.split(":").let { p -> (p.getOrNull(0)?.toIntOrNull() ?: 7) to (p.getOrNull(1)?.toIntOrNull() ?: 30) }
                    TimePickerDialog(context, { _, hour, minute ->
                        c.edit(true) { it.copy(digestTime = "%02d:%02d".format(hour, minute)) }
                    }, h, m, true).show()
                }, modifier = Modifier.fillMaxWidth()) { Text(form.digestTime.ifEmpty { NUDGE_TIME }, color = Nal.colors.text) }
            }
            Column(Modifier.weight(1.4f)) {
                OutlinedTextField(
                    value = form.digestTz,
                    onValueChange = { v -> c.edit(true) { it.copy(digestTz = v) } },
                    label = { Text("Time zone") },
                    placeholder = { Text("Europe/Bratislava") },
                    singleLine = true,
                    trailingIcon = { IconButton(onClick = { zonePicker = true }) { Icon(Icons.Filled.Search, contentDescription = "Pick a time zone") } },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        val voice = form.digestVoice
        val hasSample = voice.isEmpty() || voice in SAMPLE_VOICE_IDS
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            Picker("Voice", voice, VOICE_OPTIONS, Modifier.weight(1f)) { v ->
                c.voiceSample.stop()
                c.voiceSample.setStatus(HostedController.Status())
                c.edit(true) { it.copy(digestVoice = v) }
            }
            OutlinedButton(onClick = {
                val id = voice.ifEmpty { DEFAULT_SAMPLE_VOICE }
                if (id in SAMPLE_VOICE_IDS) c.voiceSample.play(c.api.voiceSampleUrl(id))
            }, enabled = hasSample) { Text("Play sample") }
        }
        if (!hasSample) Hint("No sample for this voice. The ones listed first have one.") else StatusText(sampleStatus)

        Picker(
            "Which app reads your DMs?",
            form.digestFormat,
            DM_FORMATS.map { (it.value ?: "") to it.label },
            Modifier.fillMaxWidth().padding(top = 8.dp),
        ) { v -> c.edit(true) { it.copy(digestFormat = v) } }
        Hint(DM_FORMAT_HINT)

        OutlinedButton(onClick = c::saveDigestSchedule, enabled = !savingSchedule, modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) {
            Text("Save digest schedule")
        }
        StatusText(scheduleStatus)
        Hint(lastStatus)
        val writing = digests.generation != null
        OutlinedButton(onClick = c::sendDigestNow, enabled = !writing, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text("Send me a digest now")
        }
        if (writing) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 6.dp))
        StatusText(nowStatus)
    }

    if (zonePicker) {
        ZonePicker(current = form.digestTz, onDismiss = { zonePicker = false }) { z ->
            zonePicker = false
            c.edit(true) { it.copy(digestTz = z) }
        }
    }
}

@Composable
private fun ZonePicker(current: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val matches = remember(query) {
        val q = query.trim().replace(' ', '_')
        if (q.isEmpty()) TIME_ZONES else TIME_ZONES.filter { it.contains(q, ignoreCase = true) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Time zone") },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Search, for example Bratislava") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                LazyColumn(Modifier.heightIn(max = 360.dp).padding(top = 8.dp)) {
                    items(matches, key = { it }) { z ->
                        Text(
                            z,
                            fontWeight = if (z == current) FontWeight.Bold else FontWeight.Normal,
                            color = Nal.colors.text,
                            modifier = Modifier.fillMaxWidth().clickable { onPick(z) }.padding(vertical = 10.dp),
                        )
                        HorizontalDivider(color = Nal.colors.line)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun HostedDeviceExtra(c: HostedController) {
    val status by c.deviceStatus.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { target ->
        if (target != null) c.exportAccount(context, target)
    }
    Hint(
        "Our server keeps your settings, words, learned taste, scores, rankings, digests and private more/less feedback to run the service, and sends the notes' text to the model provider it uses to rank them and write digests. Digest audio is uploaded to public file hosts: anyone with the link can play it. Link previews are fetched by the server. Payments are handled by a separate billing service. This phone keeps a copy of your ranking and digests for offline use.",
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        OutlinedButton(onClick = { exporter.launch("nalgorithm-account-${LocalDate.now()}.json") }) { Text("Download my hosted data") }
    }
    Row(Modifier.padding(top = 8.dp)) {
        DangerButton("Delete my hosted data", enabled = !confirming) { confirming = true }
    }
    if (confirming) {
        StateCard(Modifier.padding(top = 8.dp), error = true) {
            Text(
                "This deletes your settings, words, learned taste, scores, rankings, digests and schedule from our server, and signs you out. " +
                    "It cannot be undone. Audio already uploaded to public file hosts stays reachable by its link, and payment records stay with the billing service, so paid time is not lost.",
                color = Nal.colors.text,
            )
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DangerButton("Delete my hosted data", enabled = !deleting) {
                    deleting = true
                    scope.launch {
                        c.deleteAccount()
                        deleting = false
                        confirming = false
                    }
                }
                TextButton(onClick = { confirming = false }, enabled = !deleting) { Text("Cancel") }
            }
        }
    }
    StatusText(status)
}

@Composable
private fun SaveArea(c: HostedController) {
    val status by c.tuneStatus.collectAsState()
    val saving by c.saving.collectAsState()
    Column {
        StatusText(status)
        Button(onClick = c::saveSettingsForm, enabled = !saving, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) { Text("Save") }
    }
}

@Composable
private fun ThisDeviceSection(c: HostedController) {
    val uri = LocalUriHandler.current
    TuneSection("This device") {
        Hint("You are using the hosted service. The server ranks your feed and writes your digest.")
        OutlinedButton(onClick = c::useOwnKey, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Use my own API key instead") }
        OutlinedButton(onClick = c::signOut, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Log out") }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
            Text("Version ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
            Spacer(Modifier.size(8.dp))
            TextButton(onClick = { runCatching { uri.openUri("https://github.com/jooray/nalgorithm") } }) { Text("Source on GitHub") }
        }
    }
    Spacer(Modifier.height(24.dp))
}
