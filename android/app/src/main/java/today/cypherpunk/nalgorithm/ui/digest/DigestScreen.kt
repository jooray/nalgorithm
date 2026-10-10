package today.cypherpunk.nalgorithm.ui.digest

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Notes
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Replay
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.audio.ANOTHER_DIGEST_HINT
import today.cypherpunk.nalgorithm.audio.DigestLabels
import today.cypherpunk.nalgorithm.audio.DigestUi
import today.cypherpunk.nalgorithm.audio.NotesTab
import today.cypherpunk.nalgorithm.audio.PlayerMode
import today.cypherpunk.nalgorithm.audio.PlayerState
import today.cypherpunk.nalgorithm.audio.SPEEDS
import today.cypherpunk.nalgorithm.audio.digestLengthLabel
import today.cypherpunk.nalgorithm.audio.exactSeconds
import today.cypherpunk.nalgorithm.audio.firstLines
import today.cypherpunk.nalgorithm.audio.formatClock
import today.cypherpunk.nalgorithm.audio.formatLength
import today.cypherpunk.nalgorithm.audio.formatSpeed
import today.cypherpunk.nalgorithm.audio.keyOf
import today.cypherpunk.nalgorithm.audio.makeButtonView
import today.cypherpunk.nalgorithm.audio.notePubkeys
import today.cypherpunk.nalgorithm.audio.notesProfiles
import today.cypherpunk.nalgorithm.audio.paragraphs
import today.cypherpunk.nalgorithm.audio.resumeHint
import today.cypherpunk.nalgorithm.audio.toScoredPost
import today.cypherpunk.nalgorithm.audio.wordCount
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.ui.notes.NoteCard
import today.cypherpunk.nalgorithm.ui.theme.Nal
import java.io.File
import kotlin.math.max

/** The Digests tab (web/src/digest-view.ts): hero player, show notes, and the digest feed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DigestScreenImpl(graph: AppGraph, modifier: Modifier = Modifier) {
    val audio = graph.audio
    val ui by audio.ui.collectAsState()
    val s by audio.player.state.collectAsState()
    val mode by graph.modeStore.mode.collectAsState()
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // Download MP3 / Save MP3: the file is ready first, then the reader picks where it goes.
    var pendingFile by remember { mutableStateOf<File?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/mpeg")) { uri ->
        val file = pendingFile ?: return@rememberLauncherForActivityResult
        pendingFile = null
        scope.launch { audio.finishDownload(file, uri) }
    }
    val download: (Boolean) -> Unit = { made ->
        scope.launch {
            val prepared = audio.prepareDownload(made) ?: return@launch
            pendingFile = prepared.first
            saver.launch(prepared.second)
        }
    }

    val selected = ui.selected
    // Opening the notes from the list scrolls to them, like the web's scrollIntoView.
    var scrollToNotes by remember { mutableStateOf(0) }
    LaunchedEffect(scrollToNotes) {
        if (scrollToNotes > 0) listState.animateScrollToItem(if (ui.running && ui.backend?.mode == AppMode.Byok) 2 else 1)
    }

    // The tab was shown: reload the list (a new digest may have arrived meanwhile).
    val backendNow = ui.backend
    LaunchedEffect(backendNow) { backendNow?.refresh() }

    BoxWithConstraints(modifier.fillMaxSize().background(Nal.colors.bg)) {
        val wide = maxWidth >= 720.dp
        // clamp(2.5rem, 11.5vw, 3.75rem), the column capped like the web's.
        val titleSize = (minOf(maxWidth, Nal.column).value * 0.115f).coerceIn(40f, 60f).sp
        PullToRefreshBox(
            isRefreshing = ui.listLoading && ui.digests.isNotEmpty(),
            onRefresh = { audio.retryList() },
            modifier = Modifier.fillMaxSize(),
        ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item(key = "hero") {
                Column(Modifier.widthIn(max = Nal.column).fillMaxWidth()) {
                    Hero(graph, ui, s, wide, titleSize, download)
                }
            }
            if (ui.running && (ui.backend?.mode == AppMode.Byok || !ui.generation?.text.isNullOrBlank())) {
                item(key = "gen") { Column(Modifier.widthIn(max = Nal.column).fillMaxWidth()) { Generation(ui) } }
            }
            if (selected != null && ui.notesOpen) {
                showNotes(graph, ui, selected)
            }
            digestFeed(graph, ui, s, mode, onOpenNotes = { id ->
                audio.selectDigest(id, openNotes = true, play = false)
                scrollToNotes++
            })
        }
        }
    }
}

// ─── hero ────────────────────────────────────────────────────────────────────

@Composable
private fun Hero(graph: AppGraph, ui: DigestUi, s: PlayerState, wide: Boolean, titleSize: TextUnit, download: (Boolean) -> Unit) {
    val audio = graph.audio
    val d = ui.selected
    val c = Nal.colors
    Column(
        Modifier
            .then(if (wide) Modifier.padding(top = 16.dp) else Modifier)
            .fillMaxWidth()
            .clip(if (wide) HeroShapeWide else HeroShape)
            .background(c.hero)
            .then(if (wide) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars))
            .padding(start = Nal.gutter, end = Nal.gutter, top = if (wide) 36.dp else 28.dp, bottom = if (d == null) 32.dp else 24.dp),
    ) {
        val line2 = if (d != null) formatLength(s.dur, s.durApprox || (s.mode == PlayerMode.Audio && !s.played && exactSeconds(d) == null)) else null
        Text(
            text = if (d != null) "Your morning," else "No digest yet.",
            color = c.onHero, fontSize = titleSize, fontWeight = FontWeight.ExtraBold,
            lineHeight = titleSize * 1.02f, letterSpacing = (-0.035).em,
            modifier = Modifier.semantics { heading() },
        )
        if (d != null && line2 != null) {
            Text(line2, color = c.onHero, fontSize = titleSize, fontWeight = FontWeight.ExtraBold, lineHeight = titleSize * 1.02f, letterSpacing = (-0.035).em)
            val speech = s.mode == PlayerMode.Speech
            Text(
                "${DigestLabels.whenLabel(d.createdAt)}${if (speech) " · read aloud by your phone" else ""}",
                color = c.onHero2, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        if (d == null) HeroEmpty(graph, ui) else Player(graph, ui, d, s, download)
    }
}

@Composable
private fun HeroEmpty(graph: AppGraph, ui: DigestUi) {
    val backend = ui.backend ?: return
    val view = makeButtonView(ui.running, ui.digests.isNotEmpty(), backend.makeLabel, backend.makeAnotherLabel)
    Column(Modifier.padding(top = 20.dp)) {
        if (backend.emptyText.isNotEmpty()) {
            Text(
                backend.emptyText, color = Nal.colors.onHero2, fontSize = 17.sp,
                modifier = Modifier.widthIn(max = 420.dp).padding(bottom = 22.dp),
            )
        }
        Button(
            onClick = { graph.audio.make() },
            enabled = !view.disabled,
            modifier = Modifier.heightIn(min = 52.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color.White, contentColor = Nal.colors.hero,
                disabledContainerColor = Color.White.copy(alpha = 0.85f), disabledContentColor = Nal.colors.hero,
            ),
            contentPadding = PaddingValues(horizontal = 26.dp),
        ) { Text(view.label, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
        if (ui.running) IndeterminateBar(Modifier.padding(top = 12.dp), track = Color.White.copy(alpha = 0.28f), bar = Color.White)
        MakeStatus(ui, onHero = true)
    }
}

/** One line under whichever make button the reader is looking at (setMakeStatus). */
@Composable
private fun MakeStatus(ui: DigestUi, onHero: Boolean) {
    val heroShown = ui.selected == null
    if (heroShown != onHero) return
    val listState = ui.backend?.state?.collectAsState()?.value
    val g = ui.generation
    // No run going: the backend's last word ("Your digest has arrived.", "Digest ready: …", or why a run failed).
    val error = if (g != null) g.error else listState?.makeStatus?.takeIf { listState.makeStatusIsError }
    val text = when {
        error != null -> error
        g == null -> listState?.makeStatus.orEmpty()
        ui.backend?.mode == AppMode.Byok -> "Writing…"
        else -> g.status
    }
    if (text.isBlank()) return
    Text(
        text,
        color = when {
            error != null -> Nal.colors.danger.takeIf { !onHero } ?: Color.White
            onHero -> Nal.colors.onHero2
            else -> Nal.colors.text2
        },
        fontSize = 14.sp,
        modifier = Modifier.padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Player(graph: AppGraph, ui: DigestUi, d: DigestRecord, s: PlayerState, download: (Boolean) -> Unit) {
    val audio = graph.audio
    val c = Nal.colors
    var scrub by remember { mutableStateOf<Float?>(null) }
    Column(Modifier.padding(top = 18.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        val busy = s.playing || s.loading
        Surface(
            onClick = { audio.togglePressed() },
            enabled = s.mode != PlayerMode.None,
            shape = CircleShape,
            color = Color.White,
            contentColor = c.hero,
            modifier = Modifier
                .size(96.dp)
                .shadow(14.dp, CircleShape, ambientColor = Color(0x59140050), spotColor = Color(0x59140050))
                .semantics { contentDescription = if (busy) "Pause digest" else "Play digest" },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    if (busy) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                    contentDescription = null,
                    modifier = Modifier.size(48.dp).then(if (busy) Modifier else Modifier.offset(x = 3.dp)),
                    tint = c.hero.copy(alpha = if (s.mode == PlayerMode.None) 0.6f else if (s.loading && !s.playing) 0.85f else 1f),
                )
            }
        }

        val fraction = if (s.dur > 0) (s.pos / s.dur).toFloat() else 0f
        Waveform(
            fraction = fraction,
            enabled = s.mode != PlayerMode.None,
            valueText = "${formatClock(s.pos)} of ${formatClock(s.dur)}",
            onScrub = { scrub = it },
            onCommit = { f -> scrub = null; audio.player.seek(f * s.dur) },
            modifier = Modifier.padding(top = 18.dp),
        )
        val pos = scrub?.let { it * s.dur } ?: s.pos
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatClock(pos), color = c.onHero2, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text("-${if (s.durApprox) "~" else ""}${formatClock(max(0.0, s.dur - pos))}", color = c.onHero2, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }

        FlowRow(
            Modifier.fillMaxWidth().padding(top = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SkipButton(seconds = 15, back = true) { audio.player.skip(-15.0) }
            SpeedButton(s.speed) { audio.player.setSpeed(it) }
            SkipButton(seconds = 30, back = false) { audio.player.skip(30.0) }
            val count = d.notes?.size
            PillButton(
                onClick = { audio.toggleNotes() },
                contentPadding = PaddingValues(horizontal = 18.dp),
                modifier = Modifier.semantics { selected = ui.notesOpen },
            ) {
                Icon(Icons.AutoMirrored.Rounded.Notes, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (count == null) "Show notes" else "Show notes · $count", fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
        }

        // The hint line: an error, where to resume, played, or the part being read aloud.
        val notice = ui.notice
        val hintError = notice?.isError ?: s.error.isNotEmpty()
        val hint = notice?.text ?: s.error.ifEmpty {
            when {
                s.mode == PlayerMode.Speech && s.playing && s.speechChunks > 0 -> "Reading aloud · part ${s.speechChunk} of ${s.speechChunks}"
                s.resumeAt > 0 && !s.playing -> resumeHint(s.resumeAt) ?: ""
                s.played && !s.playing -> "Played"
                else -> ""
            }
        }
        val made = d.id in ui.made
        val offerMake = made || (ui.backend?.canMakeAudio() == true && !audio.hasAudio(d))
        val offerDownload = audio.hasAudio(d)
        if (hint.isNotEmpty() || offerMake || offerDownload) {
            FlowRow(
                Modifier.fillMaxWidth().padding(top = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                if (hint.isNotEmpty()) {
                    Text(
                        hint,
                        color = if (hintError) Color.White else c.onHero2,
                        fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .then(if (hintError) Modifier.clip(RoundedCornerShape(10.dp)).background(Color(0x660B0B10)).padding(horizontal = 12.dp, vertical = 8.dp) else Modifier)
                            .semantics { liveRegion = if (hintError) LiveRegionMode.Assertive else LiveRegionMode.Polite },
                    )
                }
                Spacer(Modifier.weight(1f))
                if (offerMake) {
                    PillButton(onClick = { if (made) download(true) else audio.makeAudio() }, enabled = !ui.makingAudio, small = true) {
                        Text(if (ui.makingAudio) "Making audio…" else if (made) "Save MP3" else "Make audio", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (offerDownload) {
                    PillButton(onClick = { download(false) }, enabled = !ui.downloading, small = true) {
                        Text("Download MP3", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun SkipButton(seconds: Int, back: Boolean, onClick: () -> Unit) {
    PillButton(
        onClick = onClick,
        contentPadding = PaddingValues(0.dp),
        modifier = Modifier.width(52.dp).semantics { contentDescription = if (back) "Back $seconds seconds" else "Forward $seconds seconds" },
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                Icons.Rounded.Replay, contentDescription = null,
                modifier = Modifier.size(30.dp).then(if (back) Modifier else Modifier.scale(scaleX = -1f, scaleY = 1f)),
            )
            Text("$seconds", fontSize = 9.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.offset(y = 2.dp))
        }
    }
}

@Composable
private fun SpeedButton(speed: Float, onPick: (Float) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        PillButton(
            onClick = { open = !open },
            modifier = Modifier.widthIn(min = 72.dp).semantics { contentDescription = "Playback speed ${formatSpeed(speed)}" },
        ) { Text(formatSpeed(speed), fontSize = 16.sp, fontWeight = FontWeight.Bold) }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = Nal.colors.surface2,
            shape = RoundedCornerShape(Nal.radiusSmall),
        ) {
            for (v in SPEEDS) {
                val on = v == speed
                DropdownMenuItem(
                    text = {
                        Row(Modifier.widthIn(min = 84.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(formatSpeed(v), fontWeight = FontWeight.SemiBold, color = if (on) Nal.colors.accentInk else Nal.colors.text, modifier = Modifier.weight(1f))
                            if (on) Box(Modifier.padding(start = 12.dp).size(8.dp).clip(CircleShape).background(Nal.colors.accentInk))
                        }
                    },
                    onClick = { onPick(v); open = false },
                    modifier = Modifier.semantics { selected = on },
                )
            }
        }
    }
}

// ─── generation (bring your own key) ─────────────────────────────────────────

@Composable
private fun Generation(ui: DigestUi) {
    val g = ui.generation ?: return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(g.startedAt) { while (true) { delay(500); now = System.currentTimeMillis() } }
    val status = g.status.ifBlank {
        // Reasoning models stay quiet before the first word: the clock is what tells "thinking" from "hung".
        val seconds = g.startedAt?.let { max(0L, now / 1000 - it) } ?: 0L
        val progress = if (g.text.isNotEmpty()) "${seconds}s, ${wordCount(g.text)} words" else "${seconds}s, thinking"
        "Writing your digest ($progress)…"
    }
    Column(
        Modifier
            .padding(start = Nal.gutter, end = Nal.gutter, top = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(Nal.radius))
            .background(Nal.colors.surface)
            .padding(18.dp)
            .semantics { liveRegion = LiveRegionMode.Polite; contentDescription = "Writing your digest" },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Spinner(Modifier.padding(end = 8.dp))
            Text(status, color = Nal.colors.text2, fontSize = 14.sp)
        }
        val paras = paragraphs(g.text)
        if (paras.isNotEmpty()) {
            Column(Modifier.padding(top = 12.dp)) {
                for (p in paras) Text(p, color = Nal.colors.text, fontSize = 16.sp, lineHeight = 25.sp, modifier = Modifier.padding(bottom = 16.dp))
            }
        }
    }
}

// ─── show notes ──────────────────────────────────────────────────────────────

private fun LazyListScope.showNotes(graph: AppGraph, ui: DigestUi, d: DigestRecord) {
    item(key = "notes-head") {
        Column(Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(top = 28.dp)) {
            Column(Modifier.padding(horizontal = Nal.gutter)) {
                Text("Show notes", color = Nal.colors.text, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.03).em, modifier = Modifier.semantics { heading() })
                val notes = d.notes
                Text(
                    if (notes == null) DigestLabels.whenLabel(d.createdAt)
                    else "${if (notes.size == 1) "1 note" else "${notes.size} notes"} it was written from, best first",
                    color = Nal.colors.text2, fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp),
                )
            }
            Segmented(ui.notesTab) { graph.audio.setNotesTab(it) }
        }
    }
    if (ui.notesTab == NotesTab.Text) {
        val paras = paragraphs(d.text)
        item(key = "notes-text") {
            Column(Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(start = Nal.gutter, end = Nal.gutter, top = 4.dp, bottom = 8.dp)) {
                if (paras.isEmpty()) Text("This digest has no text.", color = Nal.colors.text2)
                for (p in paras) Text(p, color = Nal.colors.text, fontSize = 16.sp, lineHeight = 25.sp, modifier = Modifier.padding(bottom = 16.dp))
            }
        }
        return
    }
    val notes = d.notes
    if (notes == null) {
        item(key = "notes-state") {
            LaunchedEffect(d.id) { graph.audio.fetchFull(d) }
            val failed = d.id in ui.notesFailed
            StateNote(
                if (failed) "The show notes could not be loaded. Check your connection and open this digest again." else "Loading the show notes…",
                isError = failed,
            )
        }
        return
    }
    if (notes.isEmpty()) {
        item(key = "notes-state") { StateNote("This digest did not record the notes it was written from.") }
        return
    }
    item(key = "notes-profiles") {
        // Names and pictures: what the digest kept, then what the relays say now.
        LaunchedEffect(d.id) {
            val relays = graph.active?.relays().orEmpty()
            runCatching { graph.profiles.load(notePubkeys(notes), relays) }
        }
    }
    items(notes, key = { "note-${it.id}" }) { note ->
        val known by graph.profiles.profiles.collectAsState()
        val profiles = remember(known, d.profiles, note.pubkey) { notesProfiles(d.profiles, known, listOf(note.pubkey)) }
        Box(Modifier.widthIn(max = Nal.column).fillMaxWidth()) {
            NoteCard(graph, toScoredPost(note), profiles, showActions = true)
        }
    }
}

@Composable
private fun Segmented(tab: NotesTab, onPick: (NotesTab) -> Unit) {
    Row(
        Modifier
            .padding(start = Nal.gutter, end = Nal.gutter, top = 16.dp, bottom = 14.dp)
            .fillMaxWidth()
            .clip(CircleShape)
            .background(Nal.colors.surface)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for ((value, label) in listOf(NotesTab.Notes to "Notes", NotesTab.Text to "Digest text")) {
            val on = value == tab
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .clip(CircleShape)
                    .background(if (on) Nal.colors.surface3 else Color.Transparent)
                    .clickable(role = Role.Tab) { onPick(value) }
                    .semantics { selected = on },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (on) Nal.colors.text else Nal.colors.text2, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun StateNote(text: String, isError: Boolean = false, modifier: Modifier = Modifier) {
    Text(
        text,
        color = if (isError) Nal.colors.danger else Nal.colors.text2,
        modifier = modifier.widthIn(max = Nal.column).fillMaxWidth().padding(horizontal = Nal.gutter, vertical = 12.dp),
    )
}

// ─── digest feed ─────────────────────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
private fun LazyListScope.digestFeed(graph: AppGraph, ui: DigestUi, s: PlayerState, mode: AppMode?, onOpenNotes: (String) -> Unit) {
    val audio = graph.audio
    val has = ui.digests.isNotEmpty()
    item(key = "feed-head") {
        Column(Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(start = Nal.gutter, end = Nal.gutter, top = 32.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Digest feed", color = Nal.colors.text, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.02).em, modifier = Modifier.weight(1f).semantics { heading() })
                val backend = ui.backend
                if (has && backend != null) {
                    val view = makeButtonView(ui.running, true, backend.makeLabel, backend.makeAnotherLabel)
                    NalButton(view.label, onClick = { audio.make() }, enabled = !view.disabled, small = true, busy = view.busy)
                }
            }
            if (has && !ui.running) Text(ANOTHER_DIGEST_HINT, color = Nal.colors.text2, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.padding(bottom = 4.dp))
        }
    }
    item(key = "feed-extras") {
        // Hosted: the schedule line and the nudge to set daily delivery.
        val active = mode?.let { graph.controller(it) }
        Box(Modifier.widthIn(max = Nal.column).fillMaxWidth()) { active?.DigestExtras(Modifier.fillMaxWidth()) }
    }
    item(key = "feed-state") {
        Column(Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(horizontal = Nal.gutter)) {
            if (ui.running && has) IndeterminateBar(Modifier.padding(top = 12.dp), track = Nal.colors.surface3, bar = Nal.colors.accentInk)
            MakeStatus(ui, onHero = false)
            if (ui.listLoading && !has) {
                Row(Modifier.padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Spinner()
                    Text("Loading your digests…", color = Nal.colors.text2)
                }
            }
            val error = ui.listError
            if (error != null) {
                Column(
                    Modifier.padding(vertical = 8.dp).fillMaxWidth().clip(RoundedCornerShape(Nal.radius)).background(Nal.colors.dangerBg).padding(22.dp)
                        .semantics { liveRegion = LiveRegionMode.Assertive },
                ) {
                    Text(error, color = Nal.colors.text)
                    NalButton("Try again", onClick = { audio.retryList() }, small = true, modifier = Modifier.padding(top = 14.dp))
                }
            }
            if (!has) {
                Text("Your digests will collect here, newest first.", color = Nal.colors.text2, modifier = Modifier.padding(vertical = 12.dp))
            }
        }
    }
    items(ui.digests, key = { "entry-${it.id}" }) { d ->
        Box(Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(start = Nal.gutter, end = Nal.gutter, top = 10.dp)) {
            DigestEntry(graph, d, ui, s, onOpenNotes)
        }
    }
}

@Composable
private fun DigestEntry(graph: AppGraph, d: DigestRecord, ui: DigestUi, s: PlayerState, onOpenNotes: (String) -> Unit) {
    val audio = graph.audio
    val c = Nal.colors
    val isSel = d.id == ui.selectedId
    val key = keyOf(d)
    val hint = if (isSel) resumeHint(s.resumeAt) else resumeHint(audio.resume.resumeAt(key))
    val played = if (isSel) s.played else audio.resume.isPlayed(key)
    val playing = isSel && (s.playing || s.loading)
    val whenText = DigestLabels.whenLabel(d.createdAt)
    val length = digestLengthLabel(audio.resume.durationOf(key), audio.resume.isPlayed(key), exactSeconds(d), d.text)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Nal.radius))
            .background(c.surface)
            .then(if (isSel) Modifier.border(BorderStroke(2.dp, c.accentInk), RoundedCornerShape(Nal.radius)) else Modifier)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Surface(
            onClick = { audio.entryPlay(d.id) },
            shape = CircleShape,
            color = c.hero,
            contentColor = Color.White,
            modifier = Modifier.size(48.dp).semantics { contentDescription = "${if (playing) "Pause" else "Play"} the digest from $whenText" },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, contentDescription = null,
                    modifier = Modifier.size(26.dp).then(if (playing) Modifier else Modifier.offset(x = 1.dp)),
                )
            }
        }
        Column(
            Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .clickable(onClickLabel = "Open the digest from ${DigestLabels.dayLabel(d.createdAt)} and its show notes") { onOpenNotes(d.id) },
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(DigestLabels.dayLabel(d.createdAt), color = c.text, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.01).em)
                Text(
                    "${DigestLabels.clockLabel(d.createdAt)} · $length", color = c.text3, fontSize = 14.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 10.dp).weight(1f),
                )
                val state = hint ?: if (played) "Played" else ""
                if (state.isNotEmpty()) {
                    Text(
                        state,
                        color = if (hint == null) c.text3 else c.accentInk,
                        fontSize = 13.sp,
                        fontWeight = if (hint == null) FontWeight.SemiBold else FontWeight.Bold,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
            Text(firstLines(d.text, 2).ifEmpty { "No text" }, color = c.text2, fontSize = 15.sp, lineHeight = 22.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val count = d.notes?.size
            Text(
                when (count) {
                    null -> "Show notes"
                    1 -> "1 note in the show notes"
                    else -> "$count notes in the show notes"
                },
                color = c.accentInk, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
