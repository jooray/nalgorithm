package today.cypherpunk.nalgorithm.ui.notes

import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem as ExoItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.ImageRequest
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.mode.LinkPreview
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.theme.Nal

/** Avatar (opens the profile). Falls back to an initial from the name; data saver never contacts the avatar's host. */
@Composable
internal fun Avatar(pubkey: String, profile: ProfileData?, options: NoteOptions, size: Int, open: ((String) -> Unit)? = null) {
    val c = Nal.colors
    var failed by remember(profile?.picture) { mutableStateOf(false) }
    val picture = profile?.picture?.takeIf { ClientUrl.safeLink(it) != null && it.startsWith("http", ignoreCase = true) }
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(c.surface3)
            .then(if (open != null) Modifier.clickable(onClickLabel = "Open profile") { open(options.profileHref(pubkey)) } else Modifier)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        if (picture != null && !options.dataSaver && !failed) {
            AsyncImage(
                model = picture,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size.dp),
                onError = { failed = true },
            )
        } else {
            Text(avatarInitial(profile), color = c.text2, fontWeight = FontWeight.Bold, fontSize = if (size >= 40) 18.sp else 12.sp)
        }
    }
}

/** Body, link cards, media and the quoted note: the part a card and its detail sheet share. */
@Composable
internal fun NoteBody(graph: AppGraph, post: ScoredPost, people: Map<String, ProfileData>, options: NoteOptions, maxLines: Int = Int.MAX_VALUE) {
    val open = rememberLinkOpener(graph)
    ContentText(post.content, people, options, open, Modifier.padding(top = 6.dp), maxLines = maxLines)
    LinkPreviewCards(graph, post.content)
    // Hosted posts carry `media` (the server's imeta summary); BYOK reads the raw tags.
    val media = remember(post.content, post.media, post.rawEvent) {
        NoteMedia.extract(post.content, post.media ?: NoteMedia.readImeta(post.rawEvent?.tags))
    }
    if (media.isNotEmpty()) MediaList(media, options, open)
    val quoted = post.quotedPost
    val original = post.originalPost
    if (post.type == PostType.Quote && quoted != null) EmbeddedNote(graph, quoted, people, options)
    // Only reached for a boost that was not folded (kept for safety).
    else if (post.type == PostType.Boost && original != null) EmbeddedNote(graph, original, people, options)
}

/**
 * Post text as an annotated string: plain text stays text, `nostr:npub/nprofile`
 * mentions become "@name" links, note references "[referenced post]", URLs links,
 * and media URLs are dropped because they render as media.
 */
internal fun buildContent(
    content: String,
    people: Map<String, ProfileData>,
    options: NoteOptions,
    link: SpanStyle,
    muted: SpanStyle,
    mono: SpanStyle,
    open: (String) -> Unit,
): AnnotatedString = buildAnnotatedString {
    val tokens = tokenizeContent(content)
    tokens.forEachIndexed { i, token ->
        when (token) {
            is ContentToken.Text -> {
                var t = token.text.replace(Regex("\n{3,}"), "\n\n")
                if (i == 0) t = t.trimStart()
                if (i == tokens.lastIndex) t = t.trimEnd()
                append(t)
            }
            is ContentToken.Profile -> {
                val pk = token.pubkey
                if (pk == null) append("@unknown")
                else {
                    val l = authorLabel(pk, people[pk])
                    withLink(LinkAnnotation.Clickable("p:$pk:$i", TextLinkStyles(if (l.isNpub) mono else link.copy(fontWeight = FontWeight.SemiBold))) { open(options.profileHref(pk)) }) {
                        append("@" + if (l.isNpub) l.text.take(16) + "…" else l.text)
                    }
                }
            }
            is ContentToken.Ref -> {
                val href = ClientUrl.safeLink(ClientUrl.buildEventUrl(options.eventTemplate, token.bech32))
                if (href == null) append("[referenced post]")
                else withLink(LinkAnnotation.Clickable("e:$i", TextLinkStyles(muted)) { open(href) }) { append("[referenced post]") }
            }
            is ContentToken.Url -> {
                if (!NoteMedia.isMediaUrl(token.url)) {
                    val safe = ClientUrl.safeLink(token.url)
                    if (safe != null) withLink(LinkAnnotation.Clickable("u:$i", TextLinkStyles(link)) { open(safe) }) { append(token.url) }
                    else append(token.url)
                    append(token.trailing)
                }
            }
        }
    }
}

@Composable
internal fun ContentText(
    content: String,
    people: Map<String, ProfileData>,
    options: NoteOptions,
    open: (String) -> Unit,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = Nal.colors.text,
    fontSize: Int = 16,
    maxLines: Int = Int.MAX_VALUE,
) {
    val c = Nal.colors
    val text = remember(content, people, options, c) {
        buildContent(
            content, people, options,
            link = SpanStyle(color = c.accentInk),
            muted = SpanStyle(color = c.text2, textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline),
            mono = SpanStyle(color = c.text2, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
            open = open,
        )
    }
    if (text.isEmpty()) return
    Text(
        text,
        modifier = modifier,
        color = color,
        fontSize = fontSize.sp,
        lineHeight = (fontSize * 1.5).sp,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun MediaList(items: List<MediaItem>, options: NoteOptions, open: (String) -> Unit) {
    Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (m in items) {
            if (m.video) VideoItem(m) else ImageItem(m, options.dataSaver, open)
        }
    }
}

/**
 * An image in its own proportions: the space is reserved when the size is known, a tall
 * image is shown whole (letterboxed) rather than cropped, and a tap opens the full file.
 * Data saver: nothing is requested from the image host until the reader asks.
 */
@Composable
private fun ImageItem(item: MediaItem, dataSaver: Boolean, open: (String) -> Unit) {
    val c = Nal.colors
    var load by rememberSaveable(item.url) { mutableStateOf(!dataSaver) }
    var failed by remember(item.url) { mutableStateOf(false) }
    val shape = RoundedCornerShape(Nal.radiusSmall)
    val ratio = if (item.width != null && item.height != null && item.height > 0) item.width.toFloat() / item.height else null
    if (failed) {
        Text("This image could not be loaded.", color = c.text2, fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp))
        return
    }
    if (!load) {
        val host = NoteMedia.hostOf(item.url)
        val label = item.alt?.let { "Load image: $it" } ?: ("Load image" + if (host.isNotEmpty()) " from $host" else "")
        Box(
            Modifier
                .fillMaxWidth()
                .then(if (ratio != null) Modifier.aspectRatio(ratio.coerceIn(0.5f, 4f)) else Modifier)
                .heightIn(min = 72.dp, max = 560.dp)
                .clip(shape)
                .background(c.surface2)
                .border(1.dp, c.line, shape)
                .clickable(role = Role.Button) { load = true }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) { Text(label, color = c.text2, fontSize = 15.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
        return
    }
    val description = item.alt ?: "Image without a description"
    AsyncImage(
        model = item.url,
        contentDescription = description,
        contentScale = ContentScale.Fit,
        onError = { failed = true },
        modifier = Modifier
            .fillMaxWidth()
            .then(if (ratio != null) Modifier.aspectRatio(ratio.coerceAtLeast(560f / 2000f)) else Modifier)
            .heightIn(max = 560.dp)
            .clip(shape)
            .background(c.surface2)
            .clickable(onClickLabel = item.alt?.let { "Open full image: $it" } ?: "Open full image") { open(item.url) },
    )
}

/**
 * Click-to-load: nothing is requested until the placeholder is tapped. For an MP4 whose
 * index sits at the end of the file even "metadata" means megabytes, and a busy feed
 * carries dozens of clips nobody asked to watch.
 */
@Composable
private fun VideoItem(item: MediaItem) {
    val c = Nal.colors
    var playing by rememberSaveable(item.url) { mutableStateOf(false) }
    val shape = RoundedCornerShape(Nal.radiusSmall)
    if (!playing) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 140.dp)
                .clip(shape)
                .background(c.surface2)
                .clickable(role = Role.Button, onClickLabel = "Load video") { playing = true }
                .semantics { contentDescription = "Load video" },
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Rounded.PlayArrow, contentDescription = null, tint = c.text2, modifier = Modifier.size(28.dp))
            Text("Load video", color = c.text2, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
        return
    }
    InlineVideo(item, Modifier.fillMaxWidth().clip(shape).background(c.surface2))
}

@OptIn(UnstableApi::class)
@Composable
private fun InlineVideo(item: MediaItem, modifier: Modifier) {
    val context = LocalContext.current
    val player = remember(item.url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(ExoItem.fromUri(item.url))
            volume = 0f
            playWhenReady = true
            prepare()
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    val ratio = if (item.width != null && item.height != null && item.height > 0) item.width.toFloat() / item.height else 16f / 9f
    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                this.player = player
                useController = true
                setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            }
        },
        update = { it.player = player },
        modifier = modifier.aspectRatio(ratio.coerceIn(0.5f, 3f)).heightIn(max = 560.dp),
    )
}

/** A quoted note (or an unfolded boost's original): small avatar, name, text and its media. */
@Composable
private fun EmbeddedNote(graph: AppGraph, post: EmbeddedPost, people: Map<String, ProfileData>, options: NoteOptions) {
    val c = Nal.colors
    val open = rememberLinkOpener(graph)
    val shape = RoundedCornerShape(Nal.radiusSmall)
    Column(Modifier.padding(top = 10.dp).fillMaxWidth().border(1.dp, c.line, shape).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 6.dp)) {
            Avatar(post.author, people[post.author], options, size = 24)
            val l = authorLabel(post.author, people[post.author])
            Text(
                if (l.isNpub) l.text.take(16) + "…" else l.text,
                color = c.text2, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = if (l.isNpub) FontFamily.Monospace else null,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clickable(onClickLabel = "Open profile") { open(options.profileHref(post.author)) },
            )
        }
        ContentText(post.content, people, options, open, color = c.text2, fontSize = 15)
        LinkPreviewCards(graph, post.content)
        val media = remember(post.content) { NoteMedia.extract(post.content, emptyList()) }
        if (media.isNotEmpty()) MediaList(media, options, open)
    }
}

// ─── Link cards (hosted previews.ts) ─────────────────────────────────────────

/** One answer per mode and URL, at most two fetches at a time; a failure is not remembered, so a later draw retries. */
internal object PreviewCache {
    private val answers = object : LinkedHashMap<String, Deferred<LinkPreview?>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Deferred<LinkPreview?>>?) = size > 256
    }
    private val limit = Semaphore(2)

    fun load(graph: AppGraph, url: String): Deferred<LinkPreview?>? {
        val mode = graph.active ?: return null
        val key = "${mode.mode}:$url"
        synchronized(answers) {
            answers[key]?.let { return it }
            val job = graph.scope.async {
                try {
                    limit.withPermit { mode.linkPreview(url) }
                } catch (e: Exception) {
                    synchronized(answers) { answers.remove(key) }
                    null
                }
            }
            answers[key] = job
            return job
        }
    }
}

@Composable
internal fun LinkPreviewCards(graph: AppGraph, content: String) {
    val urls = remember(content) { LinkPreviews.extractPreviewUrls(content, OWN_HOST) }
    if (urls.isEmpty()) return
    Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (url in urls) {
            val card by produceState<LinkPreview?>(null, url) { value = PreviewCache.load(graph, url)?.await() }
            card?.let { PreviewCard(graph, it) }
        }
    }
}

private const val OWN_HOST = "nalgorithm.cypherpunk.today"

@Composable
private fun PreviewCard(graph: AppGraph, card: LinkPreview) {
    val c = Nal.colors
    val open = rememberLinkOpener(graph)
    val context = LocalContext.current
    val shape = RoundedCornerShape(Nal.radiusSmall)
    var imageFailed by remember(card.imageUrl) { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, c.line, shape)
            .clickable(onClickLabel = "Open link") { open(card.url) },
    ) {
        if (card.imageUrl != null && !imageFailed) {
            val request = remember(card.imageUrl, card.imageHeaders) {
                ImageRequest.Builder(context)
                    .data(card.imageUrl)
                    .httpHeaders(NetworkHeaders.Builder().apply { card.imageHeaders.forEach { (k, v) -> set(k, v) } }.build())
                    .build()
            }
            AsyncImage(
                model = request,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                onError = { imageFailed = true },
                modifier = Modifier.width(96.dp).heightIn(min = 72.dp).fillMaxHeight(),
            )
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            card.siteName?.takeIf { it.isNotBlank() }?.let { Text(it.take(100), color = c.text3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            card.title?.takeIf { it.isNotBlank() }?.let { Text(it.take(200), color = c.text, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            card.description?.takeIf { it.isNotBlank() }?.let { Text(it.take(400), color = c.text2, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}
