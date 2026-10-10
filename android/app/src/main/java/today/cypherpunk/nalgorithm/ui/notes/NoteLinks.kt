package today.cypherpunk.nalgorithm.ui.notes

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.toArgb
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.shell.Toaster

/** Link options derived from the reader's device settings; shared by every note (render.ts clientRenderOptions). */
@Immutable
data class NoteOptions(
    val eventTemplate: String,
    val profileTemplate: String,
    val preset: String,
    /** Relays to hint in copied nprofiles and nevents: the ones this app reads from. */
    val relayHints: List<String>,
    val dataSaver: Boolean,
) {
    val clientLabel: String get() = ClientPreset.label(preset)

    fun profileHref(pubkey: String): String =
        ClientUrl.safeLink(ClientUrl.buildProfileUrl(profileTemplate, NoteIds.npub(pubkey), NoteIds.nprofile(pubkey, relayHints), pubkey)).orEmpty()

    fun eventHref(nevent: String): String =
        if (nevent.isEmpty()) "" else ClientUrl.safeLink(ClientUrl.buildEventUrl(eventTemplate, nevent)).orEmpty()
}

@Composable
fun rememberNoteOptions(graph: AppGraph): NoteOptions {
    val s by graph.deviceSettings.settings.collectAsState()
    val mode by graph.modeStore.mode.collectAsState()
    return remember(s.clientPreset, s.clientCustomUrl, s.clientCustomProfileUrl, s.dataSaver, mode) {
        NoteOptions(
            eventTemplate = ClientUrl.resolveTemplate(s.clientPreset, s.clientCustomUrl),
            profileTemplate = ClientUrl.resolveProfileTemplate(s.clientPreset, s.clientCustomProfileUrl),
            preset = s.clientPreset,
            relayHints = runCatching { graph.active?.relays().orEmpty() }.getOrDefault(emptyList()),
            dataSaver = s.dataSaver,
        )
    }
}

/** Identifiers and links for a note, computed once and used by the row, the menu and the sheet. */
@Immutable
data class NoteLinkSet(val npub: String, val nprofile: String, val nevent: String, val eventHref: String, val profileHref: String)

fun linksFor(post: ScoredPost, o: NoteOptions): NoteLinkSet {
    val nevent = NoteIds.nevent(post.id, post.author, post.rawEvent?.kind ?: 1, o.relayHints.take(3))
    return NoteLinkSet(
        npub = NoteIds.npub(post.author),
        nprofile = NoteIds.nprofile(post.author, o.relayHints),
        nevent = nevent,
        eventHref = o.eventHref(nevent),
        profileHref = o.profileHref(post.author),
    )
}

object Links {
    /**
     * Open a link the way a reader expects: web pages in a Custom Tab, `nostr:`
     * links in whichever app registered the scheme. Unsafe schemes never open.
     */
    fun open(context: Context, url: String, toaster: Toaster? = null, dark: Boolean = true, toolbar: Int? = null) {
        val safe = ClientUrl.safeLink(url) ?: return
        val uri = Uri.parse(safe)
        val scheme = uri.scheme?.lowercase()
        try {
            if (scheme == "http" || scheme == "https") {
                val params = CustomTabColorSchemeParams.Builder().apply { toolbar?.let { setToolbarColor(it) } }.build()
                CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setColorScheme(if (dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
                    .setDefaultColorSchemeParams(params)
                    .build()
                    .apply { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                    .launchUrl(context, uri)
            } else {
                // web+nostr: is the browser spelling of the same thing.
                val target = if (scheme == "web+nostr") Uri.parse("nostr:" + safe.substringAfter(':')) else uri
                context.startActivity(Intent(Intent.ACTION_VIEW, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        } catch (_: ActivityNotFoundException) {
            if (scheme == "http" || scheme == "https") {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    .onFailure { toaster?.show("No app on this phone opens web links.", isError = true) }
            } else {
                toaster?.show("No app on this phone opens nostr: links. Choose another client under Open notes in, in Tune.", isError = true)
            }
        }
    }

    /** Copy [text]; Android 13+ confirms on its own, older versions get a toast. */
    fun copy(context: Context, text: String, toaster: Toaster? = null): Boolean {
        if (text.isEmpty()) return false
        val ok = runCatching {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("nalgorithm", text))
        }.isSuccess
        if (!ok) toaster?.show("Copy failed", isError = true)
        else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) toaster?.show("Copied")
        return ok
    }
}

/** Colours for the Custom Tab toolbar: the page ground, so a link feels like part of the app. */
@Composable
fun rememberLinkOpener(graph: AppGraph): (String) -> Unit {
    val context = androidx.compose.ui.platform.LocalContext.current
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val bg = today.cypherpunk.nalgorithm.ui.theme.Nal.colors.bg.toArgb()
    return remember(context, dark, bg) { { url: String -> Links.open(context, url, graph.toasts, dark, bg) } }
}
