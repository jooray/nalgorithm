package today.cypherpunk.nalgorithm.byok

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.BuildConfig
import today.cypherpunk.nalgorithm.audio.SpeechVoices
import today.cypherpunk.nalgorithm.engine.Nip19
import today.cypherpunk.nalgorithm.nostr.SignInPanel
import today.cypherpunk.nalgorithm.nostr.SignInPurpose
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.tune.DeviceSection
import today.cypherpunk.nalgorithm.ui.tune.OpenNotesInSection
import today.cypherpunk.nalgorithm.ui.tune.PrivateFeedbackSection
import today.cypherpunk.nalgorithm.ui.tune.PromptField
import today.cypherpunk.nalgorithm.ui.tune.ReadingAndListeningSection
import today.cypherpunk.nalgorithm.ui.tune.TuneSection

private data class PhoneVoice(val name: String, val label: String)

/** The voices of the phone's own speech engine, for Read aloud (the web lists the browser's). */
@Composable
private fun rememberPhoneVoices(): List<PhoneVoice> {
    val context = LocalContext.current
    var voices by remember { mutableStateOf<List<PhoneVoice>>(emptyList()) }
    LaunchedEffect(Unit) {
        voices = runCatching { SpeechVoices.list(context.applicationContext) }.getOrDefault(emptyList())
            .map { PhoneVoice(it.name, "${it.name} (${it.lang})") }
    }
    return voices
}

/** The Tune tab of bring-your-own-key mode (web index.html #tune-byok and ui.ts). */
@Composable
internal fun ByokTune(c: ByokController, graph: AppGraph, modifier: Modifier) {
    val saved by c.settings.collectAsState()
    val learned by c.learnedPrompt.collectAsState()
    val running by c.running.collectAsState()
    val device by graph.deviceSettings.settings.collectAsState()
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current

    LaunchedEffect(Unit) { if (c.draft == null) c.draft = saved }
    val d = c.draft ?: saved
    fun edit(change: (ByokSettings) -> ByokSettings) {
        c.draft = change(c.draft ?: saved)
    }

    var speechVoice by remember { mutableStateOf(device.speechVoice) }
    var relaysText by remember { mutableStateOf(d.relays.joinToString("\n")) }
    var signerRelaysText by remember { mutableStateOf(d.signerRelays.joinToString("\n")) }
    var showSignIn by remember { mutableStateOf(false) }
    var moreModelOpen by remember { mutableStateOf(false) }
    var relaysOpen by remember { mutableStateOf(false) }
    var busyTest by remember { mutableStateOf(false) }
    var busyModels by remember { mutableStateOf(false) }

    // Until the first save, only the three essentials show; the rest has working defaults.
    val setupIncomplete = SettingsValidation.validate(saved) != null
    val showExtras = !setupIncomplete || c.showAllSettings

    val focus = remember { SetupField.entries.associateWith { FocusRequester() } }
    LaunchedEffect(d.apiBaseUrl) { c.loadCachedCatalog(d.apiBaseUrl) }
    LaunchedEffect(c.focusField) {
        val field = c.focusField ?: return@LaunchedEffect
        if (field in setOf(SetupField.Scorer, SetupField.BatchSize, SetupField.Concurrency)) moreModelOpen = true
        if (field == SetupField.Relays) relaysOpen = true
        kotlinx.coroutines.delay(150)
        runCatching { focus.getValue(field).requestFocus() }
        c.focusField = null
    }

    val lines = { text: String -> text.split('\n').map { it.trim() }.filter { it.isNotEmpty() } }
    val voices = rememberPhoneVoices()

    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = Nal.column).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Nal.gutter, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // ── You ──
            TuneSection("You") {
                if (d.npub.isNotBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(Nal.colors.accent, CircleShape))
                        Spacer(Modifier.width(8.dp))
                        Text("Connected", color = Nal.colors.text, style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.width(8.dp))
                        val npub = d.npub.trim()
                        Text(
                            if (npub.length > 24) "${npub.take(14)}…${npub.takeLast(6)}" else npub,
                            fontFamily = FontFamily.Monospace,
                            color = Nal.colors.text2,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                if (d.npub.isBlank()) {
                    Button(onClick = { graph.signers.signerRelays = lines(signerRelaysText); showSignIn = !showSignIn }, modifier = Modifier.fillMaxWidth()) {
                        Text("Connect Nostr identity")
                    }
                } else {
                    OutlinedButton(onClick = { graph.signers.signerRelays = lines(signerRelaysText); showSignIn = !showSignIn }, modifier = Modifier.fillMaxWidth()) {
                        Text("Change identity")
                    }
                }
                if (showSignIn) {
                    SignInPanel(graph.signers, SignInPurpose.ByokIdentity, onResult = { result ->
                        // The npub form round-trips either way, and it is what a reader recognizes.
                        edit { it.copy(npub = Nip19.npubEncode(result.pubkey)) }
                        if (result.signer != null) graph.signers.remember(result)
                        showSignIn = false
                        c.tuneStatus = "Nostr identity connected" to false
                    })
                }
                FieldHint("Reading needs only your public key. Note actions connect your signer only when you choose to reply, boost, like or zap.")
                TextInput("npub or hex pubkey", d.npub, { v -> edit { it.copy(npub = v) } }, placeholder = "npub1... or hex pubkey", mono = true, focus = focus[SetupField.Npub])
            }

            // ── What you care about ──
            TuneSection("What you care about") {
                Box(Modifier.fillMaxWidth()) {
                    PromptField(d.userPrompt, { v -> edit { it.copy(userPrompt = v) } }, maxChars = 2000, label = "Your words (the ranking rule)")
                }
                if (showExtras) {
                    CheckRow(
                        d.learnFromLikes,
                        { v -> edit { it.copy(learnFromLikes = v) } },
                        "Learn from my likes",
                        "Off uses only your written interests. Previously learned taste is kept for re-enabling.",
                    )
                    TextInput("Learned from your likes", learned, {}, placeholder = "Will be generated after the first run...", readOnly = true, singleLine = false, minLines = 3)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(onClick = { c.regenerateLearned() }, enabled = !running) { Text("Update learned taste") }
                        TextButton(onClick = { c.resetLearned() }) { Text("Reset learned taste") }
                    }
                    c.learnStatus?.let { FieldHint(it, isError = it.startsWith("Error") || it.startsWith("Config error")) }
                    c.resetStatus?.let { FieldHint(it) }
                }
            }

            // ── Feed ──
            if (showExtras) {
                TuneSection("Feed") {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        NumberInput("Hours back", d.hoursBack, { v -> edit { it.copy(hoursBack = v) } }, focus[SetupField.HoursBack], Modifier.weight(1f))
                        NumberInput("Posts in digest", d.digestTopN, { v -> edit { it.copy(digestTopN = v) } }, focus[SetupField.DigestTopN], Modifier.weight(1f))
                    }
                    CheckRow(
                        d.autoRefresh,
                        { v -> edit { it.copy(autoRefresh = v) } },
                        "Update my feed automatically when I open the app",
                        "Shows the feed from last time at once, then ranks new posts in the background. Off: it only updates when you press Refresh.",
                    )
                    CheckRow(
                        d.digestForSpeech,
                        { v -> edit { it.copy(digestForSpeech = v) } },
                        "Phrase the digest for speech",
                        "Drops markdown and spells out version numbers and abbreviations, so it reads well aloud.",
                    )
                }
            }

            // ── Model ──
            TuneSection("Model") {
                SelectInput(
                    "Provider",
                    ByokSettings.PROVIDER_LABELS.entries.map { it.key to it.value },
                    d.provider,
                    { p -> if (p != d.provider) c.draft = c.changeProvider(d, p) },
                )
                TextInput(
                    "API base URL",
                    d.apiBaseUrl,
                    { v -> edit { it.copy(apiBaseUrl = v.trim()) } },
                    placeholder = "https://api.venice.ai/api/v1",
                    readOnly = d.provider != "custom",
                    mono = true,
                    focus = focus[SetupField.ApiBase],
                )
                TextInput("API key", d.apiKey, { v -> edit { it.copy(apiKey = v.trim()) } }, placeholder = "sk-...", secret = true, focus = focus[SetupField.ApiKey])
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = {
                        busyTest = true
                        scope.launch { try { c.testModel(d) } finally { busyTest = false } }
                    }, enabled = !busyTest) { Text("Test model connection") }
                    FilledTonalButton(onClick = {
                        busyModels = true
                        scope.launch { try { c.loadModels(d) } finally { busyModels = false } }
                    }, enabled = !busyModels) { Text("Load model list") }
                }
                if (ModelCatalog.isVenice(d.apiBaseUrl.trim()) && c.catalog.isNotEmpty()) {
                    FilledTonalButton(onClick = { c.draft = c.recommend(d) }) { Text("Use recommended") }
                }
                if (c.catalogStatus.isNotEmpty()) FieldHint(c.catalogStatus)
                FieldHint("The connection test makes one small request; your provider may charge for it.")
                CheckRow(
                    d.rememberKey,
                    { v -> edit { it.copy(rememberKey = v) } },
                    "Remember my API key on this device",
                    "Off keeps the key only while the app runs; you enter it again after the app is closed. Use this on shared devices.",
                )
                ModelInput("Model (scoring)", d.model, { v -> edit { it.copy(model = v.trim()) } }, "deepseek-v4-flash-0731", c.catalog, focus[SetupField.Model])
                FieldHint("Does the bulk of the work. Keep it cheap and fast.")
            }

            // ── More model options ──
            if (showExtras) {
                CollapsibleSection("More model options", moreModelOpen, { moreModelOpen = !moreModelOpen }) {
                    SelectInput(
                        "Scoring method",
                        listOf("chat" to "Chat model (scoring model above)", "decision" to "Decision model (Venice, beta)"),
                        d.scorer,
                        { v -> edit { it.copy(scorer = v) } },
                        focus[SetupField.Scorer],
                    )
                    if (d.scorer == "decision") {
                        TextInput("Decision model", d.decisionModel, { v -> edit { it.copy(decisionModel = v.trim().ifEmpty { "" }) } }, placeholder = "jev-latest", mono = true)
                    }
                    FieldHint("A decision model (Venice's jev-latest) rates each post against a fixed rubric instead of writing a reply: much faster and cheaper, and a post scores the same on every run. It writes no justification, and its scores run lower than a chat model's. Venice runs it on the anonymized tier, not the private one. The scoring model above still writes digests and learns from likes. Switching re-scores the feed.")
                    ModelInput("Model (digest)", d.digestModel, { v -> edit { it.copy(digestModel = v.trim()) } }, "same as scoring model", c.catalog)
                    FieldHint("Runs once over your top posts, so a stronger model costs little. Blank reuses the scoring model.")
                    ModelInput("Model (learning from likes)", d.learnerModel, { v -> edit { it.copy(learnerModel = v.trim()) } }, "same as scoring model", c.catalog)
                    FieldHint("Needs a large context window. Blank reuses the scoring model.")
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        NumberInput("Posts per call", d.batchSize, { v -> edit { it.copy(batchSize = v) } }, focus[SetupField.BatchSize], Modifier.weight(1f))
                        NumberInput("Parallel calls", d.concurrency, { v -> edit { it.copy(concurrency = v) } }, focus[SetupField.Concurrency], Modifier.weight(1f))
                    }
                    FieldHint("How many scoring calls run at once. 1 is sequential; 5 is roughly five times faster on a cold cache. Keep it within what your provider's rate limits allow.")
                }
            }

            // ── Digest audio ──
            if (showExtras) {
                TuneSection("Digest audio") {
                    SelectInput(
                        "Reading voice (your phone's speech)",
                        listOf("" to "Phone default") + voices.map { it.name to it.label },
                        speechVoice.takeIf { v -> v.isEmpty() || voices.isEmpty() || voices.any { it.name == v } } ?: "",
                        { speechVoice = it },
                    )
                    TextInput("TTS model (for a downloadable MP3)", d.ttsModel, { v -> edit { it.copy(ttsModel = v) } }, placeholder = "tts-kokoro", mono = true)
                    TextInput("TTS voice", d.ttsVoice, { v -> edit { it.copy(ttsVoice = v) } }, placeholder = "af_sky", mono = true)
                    FieldHint("Reading aloud with the phone's speech is free and needs nothing here. The phone gives no access to that audio, so an MP3 has to be made by your provider: set a TTS model, then press Make audio on a digest.")
                }
            }

            // ── Relays and signer ──
            if (showExtras) {
                CollapsibleSection("Relays and signer", relaysOpen, { relaysOpen = !relaysOpen }) {
                    TextInput(
                        "Relays (one wss:// address per line)",
                        relaysText,
                        { v -> relaysText = v; edit { it.copy(relays = lines(v)) } },
                        placeholder = "wss://relay.damus.io\nwss://relay.primal.net\nwss://nos.lol",
                        singleLine = false,
                        minLines = 4,
                        mono = true,
                        focus = focus[SetupField.Relays],
                    )
                    TextInput(
                        "Remote signer relays (one per line)",
                        signerRelaysText,
                        { v -> signerRelaysText = v; edit { it.copy(signerRelays = lines(v)) } },
                        singleLine = false,
                        minLines = 3,
                        mono = true,
                    )
                    FieldHint("Used only for the Amber / bunker handshake. Must relay ephemeral kind 24133.")
                }
            }

            // ── Both modes ──
            if (showExtras) {
                ReadingAndListeningSection(graph)
                PrivateFeedbackSection(graph)
                OpenNotesInSection(graph)
                DeviceSection(graph, modeSettings = { includeKey -> c.exportableSettings(includeKey) }, beforeClear = { c.clearDeviceData() })
            }

            if (setupIncomplete) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (!c.showAllSettings) {
                        FieldHint("Only what the first ranking needs is shown. Feed window, digest voice, relays, privacy and reading options have working defaults.")
                    }
                    TextButton(onClick = { c.showAllSettings = true }, enabled = !c.showAllSettings) {
                        Text(if (c.showAllSettings) "All settings are shown" else "Show all settings")
                    }
                }
            }

            // ── Save ──
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                c.tuneStatus?.let { (text, isError) -> FieldHint(text, isError) }
                Button(
                    onClick = {
                        val updated = d.copy(
                            npub = d.npub.trim(),
                            userPrompt = d.userPrompt.trim(),
                            relays = lines(relaysText),
                            signerRelays = lines(signerRelaysText),
                            decisionModel = d.decisionModel.trim().ifEmpty { "jev-latest" },
                            ttsModel = d.ttsModel.trim(),
                            ttsVoice = d.ttsVoice.trim(),
                        )
                        c.save(updated, speechVoice)
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (setupIncomplete) "Save and rank my feed" else "Save") }
            }

            // ── This device ──
            Surface(color = Nal.colors.surface, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("This device", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = Nal.colors.text)
                    FieldHint("You are using your own model key. Everything runs on this phone.")
                    OutlinedButton(onClick = { c.switchToHosted() }, modifier = Modifier.fillMaxWidth()) { Text("Switch to hosted mode (no key needed)") }
                    if (showExtras) {
                        OutlinedButton(onClick = { c.clearScores() }, modifier = Modifier.fillMaxWidth()) { Text("Clear cached scores") }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Version ${BuildConfig.VERSION_NAME.substringBefore('+')}", style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = { uri.openUri("https://github.com/jooray/nalgorithm") }) { Text("Source on GitHub") }
                    }
                }
            }
        }
    }
}
