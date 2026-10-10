package today.cypherpunk.nalgorithm.ui.shell

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.Alignment
import androidx.compose.runtime.getValue
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import today.cypherpunk.nalgorithm.ui.theme.Nal

/**
 * One short message at a time (web/src/toast.ts), with an optional action
 * (Retry, Undo). A plain toast goes after 4.5 s; one with an action has no
 * timer, so it can be reached with a screen reader. An Undo toast does not
 * linger either: the reader's next tap elsewhere or key press closes it
 * (scrolling does not count), and Ctrl+Z on a keyboard runs it.
 */
class Toaster {
    data class Toast(
        val id: Long,
        val text: String,
        val actionLabel: String? = null,
        val action: (() -> Unit)? = null,
        val isUndo: Boolean = false,
        val isError: Boolean = false,
    )

    private val _current = MutableStateFlow<Toast?>(null)
    val current: StateFlow<Toast?> = _current.asStateFlow()

    /** Open sheets, innermost last: the toast is drawn inside the top one, like the web puts it inside a modal dialog. */
    internal val sheetDepth = MutableStateFlow(0)

    /** Where the toast is on screen, so a tap on it does not count as the "next action". */
    internal var bounds: Rect? = null

    fun show(text: String, actionLabel: String? = null, isError: Boolean = false, action: (() -> Unit)? = null) {
        if (text.isEmpty()) return
        _current.value = Toast(System.nanoTime(), text, actionLabel, action, isError = isError)
    }

    /** An Undo toast: closes at the next action, and Undo runs [undo]. */
    fun undo(text: String, undo: () -> Unit) {
        _current.value = Toast(System.nanoTime(), text, "Undo", undo, isUndo = true)
    }

    fun dismiss() { _current.value = null }

    /** Dismiss only this toast (a timer must not close a newer one). */
    internal fun dismiss(id: Long) { if (_current.value?.id == id) _current.value = null }

    /** The reader did something else: an Undo toast goes. */
    fun onNextAction() { if (_current.value?.isUndo == true) _current.value = null }

    /** Ctrl+Z / Cmd+Z: run the Undo on screen. True when there was one. */
    fun runUndo(): Boolean {
        val t = _current.value ?: return false
        if (!t.isUndo) return false
        _current.value = null
        t.action?.invoke()
        return true
    }
}

/** The app's toaster, for components that have no [today.cypherpunk.nalgorithm.AppGraph] at hand (sheets). */
val LocalToaster = staticCompositionLocalOf<Toaster?> { null }

/** Draws [Toaster.current] when [level] is the innermost open layer (0 = the app, n = the n-th open sheet). */
@Composable
fun ToastHost(toaster: Toaster, level: Int, modifier: Modifier = Modifier) {
    val toast by toaster.current.collectAsState()
    val depth by toaster.sheetDepth.collectAsState()
    val t = toast
    LaunchedEffect(t?.id) {
        if (t != null && t.action == null) {
            delay(4_500)
            toaster.dismiss(t.id)
        }
    }
    AnimatedVisibility(
        visible = t != null && depth == level,
        modifier = modifier,
        enter = fadeIn() + slideInVertically { it / 3 },
        exit = fadeOut() + slideOutVertically { it / 3 },
    ) {
        val shown = remember(t?.id) { t } ?: return@AnimatedVisibility
        ToastBody(shown, onAction = {
            toaster.dismiss(shown.id)
            shown.action?.invoke()
        }, onDismiss = { toaster.dismiss(shown.id) }, onPlaced = { toaster.bounds = it })
    }
}

@Composable
private fun ToastBody(t: Toaster.Toast, onAction: () -> Unit, onDismiss: () -> Unit, onPlaced: (Rect) -> Unit) {
    val c = Nal.colors
    val shape = RoundedCornerShape(22.dp)
    Row(
        Modifier
            .padding(horizontal = 12.dp)
            .widthIn(max = 480.dp)
            .fillMaxWidth()
            .onGloballyPositioned { onPlaced(it.boundsInWindow()) }
            .shadow(16.dp, shape)
            .clip(shape)
            .background(if (t.isError) c.surface2 else c.surface3)
            .then(if (t.isError) Modifier.border(1.dp, c.danger, shape) else Modifier)
            .semantics { liveRegion = if (t.isError) LiveRegionMode.Assertive else LiveRegionMode.Polite }
            .padding(start = 18.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            t.text,
            Modifier.weight(1f).padding(vertical = 6.dp),
            color = if (t.isError) c.danger else c.text,
            fontSize = 15.sp,
            lineHeight = 20.sp,
        )
        if (t.actionLabel != null && t.action != null) {
            Button(
                onClick = onAction,
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent),
                contentPadding = PaddingValues(horizontal = 16.dp),
                modifier = Modifier.heightIn(min = 40.dp),
                elevation = null,
            ) { Text(t.actionLabel, fontWeight = FontWeight.Bold, fontSize = 14.sp) }
        }
        TextButton(
            onClick = onDismiss,
            modifier = Modifier.heightIn(min = 44.dp),
            contentPadding = PaddingValues(horizontal = 8.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = if (t.isError) c.danger else c.text),
        ) { Text("Dismiss", fontSize = 15.sp) }
    }
}

/** Counts a sheet as open for the toast while it is in composition; returns its layer (1 = the first sheet). */
@Composable
fun rememberSheetLevel(toaster: Toaster?): Int {
    if (toaster == null) return 0
    val level = remember(toaster) { toaster.sheetDepth.value + 1 }
    androidx.compose.runtime.DisposableEffect(toaster) {
        toaster.sheetDepth.value += 1
        onDispose { toaster.sheetDepth.value -= 1 }
    }
    return level
}
