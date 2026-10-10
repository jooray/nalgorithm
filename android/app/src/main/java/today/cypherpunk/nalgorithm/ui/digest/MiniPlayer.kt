package today.cypherpunk.nalgorithm.ui.digest

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.audio.DigestLabels
import today.cypherpunk.nalgorithm.audio.MiniLatest
import today.cypherpunk.nalgorithm.audio.MiniView
import today.cypherpunk.nalgorithm.audio.digestLengthLabel
import today.cypherpunk.nalgorithm.audio.exactSeconds
import today.cypherpunk.nalgorithm.audio.keyOf
import today.cypherpunk.nalgorithm.audio.miniView
import today.cypherpunk.nalgorithm.audio.resumeHint
import today.cypherpunk.nalgorithm.ui.theme.Nal

/**
 * The mini player on the Feed tab (web `#mini`): the latest digest, or the one being
 * written. Not a second player: its button plays in the one real player, and a tap
 * anywhere else opens the Digests tab.
 */
@Composable
fun MiniPlayerImpl(graph: AppGraph, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val audio = graph.audio
    val ui by audio.ui.collectAsState()
    val s by audio.player.state.collectAsState()

    var nowSec by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(ui.running) {
        while (ui.running) {
            nowSec = System.currentTimeMillis() / 1000
            delay(1000)
        }
    }

    val latest = ui.digests.firstOrNull()?.let { d ->
        val key = keyOf(d)
        val isSel = d.id == ui.selectedId
        val playing = isSel && (s.playing || s.loading)
        val resumeAt = if (isSel) s.resumeAt else audio.resume.resumeAt(key)
        MiniLatest(
            whenText = DigestLabels.whenLabel(d.createdAt),
            length = digestLengthLabel(audio.resume.durationOf(key), audio.resume.isPlayed(key), exactSeconds(d), d.text),
            playing = playing,
            pos = if (playing) s.pos else resumeAt,
            dur = if (isSel) s.dur else audio.resume.durationOf(key).takeIf { it > 0 } ?: exactSeconds(d) ?: 0.0,
            resumeHint = resumeHint(resumeAt),
        )
    }
    val startedAt = ui.generation?.startedAt
    val v = miniView(ui.running, if (startedAt == null) 0.0 else (nowSec - startedAt).toDouble(), latest)
    if (v == MiniView.None) return

    val c = Nal.colors
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .widthIn(max = Nal.column)
            .fillMaxWidth()
            .padding(start = Nal.gutter, end = Nal.gutter, top = 8.dp)
            .shadow(12.dp, shape, ambientColor = Color(0x4D140050), spotColor = Color(0x4D140050))
            .clip(shape)
            .background(c.hero)
            .heightIn(min = 60.dp),
    ) {
        when (v) {
            is MiniView.Running -> {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable(onClickLabel = "Open your digests") { onOpen() }
                        .padding(start = 16.dp, end = 14.dp, top = 8.dp, bottom = 14.dp)
                        .heightIn(min = 44.dp)
                        .semantics { contentDescription = "Digest being written. ${v.title}" },
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    Text(v.title, color = c.onHero, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.01).em, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("It will appear here when it is ready.", color = c.onHero2, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IndeterminateBar(
                    Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 22.dp, bottom = 6.dp),
                    track = Color.White.copy(alpha = 0.28f), bar = Color.White, height = 3,
                )
            }
            is MiniView.Ready -> {
                Row(
                    Modifier.fillMaxWidth().padding(start = 8.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Surface(
                        onClick = {
                            val d = ui.digests.firstOrNull()
                            if (d != null && d.id == ui.selectedId && (s.playing || s.loading)) audio.player.pause()
                            else {
                                audio.openLatest(play = true)
                                onOpen()
                            }
                        },
                        shape = CircleShape,
                        color = Color.White,
                        contentColor = c.hero,
                        modifier = Modifier.size(44.dp).semantics { contentDescription = v.buttonLabel },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                if (v.playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, contentDescription = null,
                                modifier = Modifier.size(24.dp).then(if (v.playing) Modifier else Modifier.offset(x = 1.dp)),
                            )
                        }
                    }
                    Column(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 44.dp)
                            .clickable(onClickLabel = v.openLabel) {
                                audio.openLatest(play = false)
                                onOpen()
                            }
                            .padding(start = 10.dp, end = 4.dp)
                            .semantics { contentDescription = "${v.openLabel}. ${v.title}, ${v.meta}${v.hint?.let { ", $it" } ?: ""}" },
                        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                    ) {
                        Row(verticalAlignment = Alignment.Bottom) {
                            Text(v.title, color = c.onHero, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.01).em, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            v.hint?.let { Text(it, color = c.onHero, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 8.dp)) }
                        }
                        Text(v.meta, color = c.onHero2, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                val progress = v.progress
                if (progress != null) {
                    Canvas(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .padding(start = 62.dp, end = 22.dp, bottom = 6.dp)
                            .height(3.dp),
                    ) {
                        val r = CornerRadius(size.height / 2)
                        drawRoundRect(Color.White.copy(alpha = 0.28f), cornerRadius = r)
                        drawRoundRect(Color.White, size = Size(size.width * progress.toFloat(), size.height), cornerRadius = r)
                    }
                }
            }
            MiniView.None -> Unit
        }
    }
}
