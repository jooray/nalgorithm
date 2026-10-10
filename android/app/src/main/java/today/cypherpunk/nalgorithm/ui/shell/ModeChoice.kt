package today.cypherpunk.nalgorithm.ui.shell

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.R
import today.cypherpunk.nalgorithm.model.AppMode
import today.cypherpunk.nalgorithm.ui.notes.rememberLinkOpener
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.theme.NalButton
import today.cypherpunk.nalgorithm.ui.theme.NalButtonKind

/** First run (#mode-choice): hosted, the recommended path, first; bring your own model second. */
@Composable
fun ModeChoice(graph: AppGraph, modifier: Modifier = Modifier) {
    val c = Nal.colors
    val open = rememberLinkOpener(graph)
    Box(modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .widthIn(max = 520.dp)
                .fillMaxWidth()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(start = 24.dp, end = 24.dp, top = 48.dp, bottom = 48.dp),
        ) {
            Box(Modifier.size(56.dp).clip(RoundedCornerShape(14.dp)).background(Color.Black)) {
                Image(
                    painterResource(R.mipmap.ic_launcher_foreground),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = 1.5f; scaleY = 1.5f },
                )
            }
            Text(
                "Hear what mattered on Nostr.",
                style = MaterialTheme.typography.displaySmall,
                color = c.text,
                modifier = Modifier.padding(top = 28.dp).semantics { heading() },
            )
            Text(
                "A spoken digest each morning, and your feed ranked by what you say you care about. Every score shows its reason.",
                color = c.text2, fontSize = 17.sp, lineHeight = 25.sp,
                modifier = Modifier.padding(top = 16.dp),
            )
            Column(Modifier.padding(top = 36.dp)) {
                Choice(
                    title = "Hosted: no API key needed",
                    text = "Recommended. Our server ranks your feed and voices your digest, and can send it as a Nostr DM each morning if you turn that on. 3 days free, then 10,000 sats per 30 days. Already subscribed? This is where you sign in, with the same Nostr key.",
                    button = "Sign in to the hosted service",
                    kind = NalButtonKind.Primary,
                ) { graph.modeStore.set(AppMode.Hosted) }
                Choice(
                    title = "Use my own model",
                    text = "Free app. Everything runs on this phone with your model key or a local model, and the key stays on this device. Your provider may charge for use. Digests are written when you ask for one.",
                    button = "Use my own model",
                    kind = NalButtonKind.Secondary,
                ) { graph.modeStore.set(AppMode.Byok) }
            }
            HorizontalDivider(color = c.line)
            val note = buildAnnotatedString {
                append("You can switch later without losing either setup. ")
                withLink(LinkAnnotation.Clickable("sample", TextLinkStyles(SpanStyle(color = c.accentInk, textDecoration = TextDecoration.Underline))) {
                    open("https://nalgorithm.cypherpunk.today/#sample")
                }) { append("Hear a sample digest first.") }
            }
            Text(note, color = c.text2, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 18.dp))
        }
    }
}

@Composable
private fun Choice(title: String, text: String, button: String, kind: NalButtonKind, onClick: () -> Unit) {
    val c = Nal.colors
    HorizontalDivider(color = c.line)
    Column(Modifier.padding(top = 22.dp, bottom = 26.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = c.text, modifier = Modifier.semantics { heading() })
        Text(text, color = c.text2, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
        NalButton(button, onClick, Modifier.fillMaxWidth(), kind = kind)
    }
}
