package today.cypherpunk.nalgorithm.ui.digest

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.provider.Settings
import today.cypherpunk.nalgorithm.audio.fractionFromPointer
import today.cypherpunk.nalgorithm.audio.waveformBars
import today.cypherpunk.nalgorithm.ui.theme.Nal
import kotlin.math.floor
import kotlin.math.max

/** The web's `.pill-btn`: a translucent dark pill on the violet hero. */
@Composable
internal fun PillButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    small: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(horizontal = 16.dp),
    content: @Composable RowScope.() -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = if (small) 44.dp else 48.dp).widthIn(min = 48.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Nal.colors.heroPill,
            contentColor = Color.White,
            disabledContainerColor = Nal.colors.heroPill,
            disabledContentColor = Color.White.copy(alpha = 0.6f),
        ),
        contentPadding = contentPadding,
        content = content,
    )
}

/** The web's `.btn` (surface pill) and `.btn-small`. */
@Composable
internal fun NalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    small: Boolean = false,
    busy: Boolean = false,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = if (small) 40.dp else 44.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Nal.colors.surface3,
            contentColor = Nal.colors.text,
            disabledContainerColor = Nal.colors.surface3.copy(alpha = if (busy) 0.85f else 0.5f),
            disabledContentColor = Nal.colors.text.copy(alpha = if (busy) 0.85f else 0.5f),
        ),
        contentPadding = PaddingValues(horizontal = if (small) 14.dp else 18.dp),
    ) {
        Text(text, fontSize = if (small) 14.sp else 15.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun Spinner(modifier: Modifier = Modifier, color: Color = Nal.colors.accentInk) {
    CircularProgressIndicator(
        modifier = modifier.size(16.dp),
        color = color,
        trackColor = Nal.colors.surface3,
        strokeWidth = 2.dp,
    )
}

/** Animations off in the system settings (prefers-reduced-motion). */
@Composable
internal fun reducedMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    }
}

/** The web's `.indet`: a sliding bar that says a digest is being written. */
@Composable
internal fun IndeterminateBar(modifier: Modifier = Modifier, track: Color, bar: Color, height: Int = 4) {
    val still = reducedMotion()
    val transition = rememberInfiniteTransition(label = "indet")
    val x by transition.animateFloat(
        initialValue = -1f,
        targetValue = 2.7f,
        animationSpec = infiniteRepeatable(tween(1500, easing = FastOutSlowInEasing), RepeatMode.Restart),
        label = "indet-x",
    )
    Canvas(modifier.fillMaxWidth().height(height.dp).clip(CircleShape).background(track)) {
        if (still) {
            drawRect(bar.copy(alpha = bar.alpha * 0.55f))
        } else {
            val w = size.width * 0.38f
            drawRoundRect(bar, topLeft = Offset(x * w, 0f), size = Size(w, size.height), cornerRadius = CornerRadius(size.height / 2))
        }
    }
}

private val PATTERN = waveformBars(180)
private const val BAR_W = 3f
private const val GAP = 3f

/**
 * The waveform progress bar (web/src/waveform.ts): a fixed picture of a voice, played part
 * full strength and the rest faint. It is also the seek control: tap or drag.
 */
@Composable
internal fun Waveform(
    fraction: Float,
    enabled: Boolean,
    valueText: String,
    onScrub: (Float?) -> Unit,
    onCommit: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    var scrub by remember { mutableStateOf<Float?>(null) }
    val scrubNow by rememberUpdatedState(onScrub)
    val commitNow by rememberUpdatedState(onCommit)
    val on = Nal.colors.waveOn
    val off = Nal.colors.waveOff
    val shown = scrub ?: fraction.coerceIn(0f, 1f).takeIf { it.isFinite() } ?: 0f
    Canvas(
        modifier
            .fillMaxWidth()
            .height(64.dp)
            .alpha(if (enabled) 1f else 0.6f)
            .semantics {
                contentDescription = "Playback position"
                stateDescription = valueText
                progressBarRangeInfo = ProgressBarRangeInfo(shown, 0f..1f)
                if (enabled) setProgress { v -> commitNow(v.coerceIn(0f, 1f)); true }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val width = size.width.toFloat()
                    var f = fractionFromPointer(down.position.x, 0f, width)
                    scrub = f
                    scrubNow(f)
                    down.consume()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        f = fractionFromPointer(change.position.x, 0f, width)
                        scrub = f
                        scrubNow(f)
                        change.consume()
                    }
                    scrub = null
                    scrubNow(null)
                    commitNow(f)
                }
            },
    ) {
        val density = this.density
        val barW = BAR_W * density
        val gap = GAP * density
        val w = size.width
        val h = size.height
        val count = max(1, floor((w + gap) / (barW + gap)).toInt())
        val span = count * barW + (count - 1) * gap
        val x0 = (w - span) / 2
        val mid = h / 2
        for (i in 0 until count) {
            val bar = PATTERN[floor(i.toDouble() / count * PATTERN.size).toInt()]
            val bh = max(4 * density, (bar * h).toFloat())
            val x = x0 + i * (barW + gap)
            drawRoundRect(
                color = if ((i + 0.5f) / count <= shown) on else off,
                topLeft = Offset(x, mid - bh / 2),
                size = Size(barW, bh),
                cornerRadius = CornerRadius(barW / 2),
            )
        }
    }
}

/** A row that centers its content and wraps when it does not fit (the web's flex-wrap rows). */
@Composable
internal fun CenteredBox(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) { content() }
}

internal val HeroShape = RoundedCornerShape(bottomStart = 32.dp, bottomEnd = 32.dp)
internal val HeroShapeWide = RoundedCornerShape(32.dp)

