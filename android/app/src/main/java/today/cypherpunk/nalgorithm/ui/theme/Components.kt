package today.cypherpunk.nalgorithm.ui.theme

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nalgorithm.ui.shell.LocalToaster
import today.cypherpunk.nalgorithm.ui.shell.ToastHost
import today.cypherpunk.nalgorithm.ui.shell.rememberSheetLevel

/**
 * The web app's controls (style.css: .btn, .state-card, label.check, select,
 * textarea, dialog.sheet, .spinner…) as Compose components, so every screen
 * draws them the same way.
 */

enum class NalButtonKind { Primary, Secondary, Ghost, Danger, Hero }

/** .btn: a pill, 44dp tall (40dp small), bold label, optional leading icon that spins while [busy]. */
@Composable
fun NalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: NalButtonKind = NalButtonKind.Secondary,
    small: Boolean = false,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    busy: Boolean = false,
) {
    val c = Nal.colors
    val (bg, fg) = when (kind) {
        NalButtonKind.Primary -> c.accent to c.onAccent
        NalButtonKind.Secondary -> c.surface3 to c.text
        NalButtonKind.Ghost -> Color.Transparent to c.text2
        NalButtonKind.Danger -> c.dangerBg to c.danger
        NalButtonKind.Hero -> Color.White to c.hero
    }
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = if (kind == NalButtonKind.Hero) 52.dp else if (small) 40.dp else 44.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = bg, contentColor = fg,
            disabledContainerColor = bg.copy(alpha = bg.alpha * 0.5f), disabledContentColor = fg.copy(alpha = 0.5f),
        ),
        contentPadding = PaddingValues(horizontal = if (small) 14.dp else if (kind == NalButtonKind.Hero) 26.dp else 18.dp),
        elevation = null,
    ) {
        if (icon != null) {
            val rotation = if (busy) spinAngle() else 0f
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp).rotate(rotation))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge.copy(fontSize = if (small) 14.sp else 15.sp))
    }
}

@Composable
private fun spinAngle(): Float {
    val t = rememberInfiniteTransition(label = "spin")
    val a by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart), label = "spin")
    return a
}

/** .link-btn: an inline text action in the accent ink. */
@Composable
fun LinkButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Nal.colors.accentInk) {
    TextButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 40.dp),
        contentPadding = PaddingValues(horizontal = 6.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = color),
    ) { Text(text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
}

/** .spinner: the small lime-topped ring. */
@Composable
fun NalSpinner(size: Dp = 16.dp, color: Color = Nal.colors.accentInk) {
    CircularProgressIndicator(
        modifier = Modifier.size(size),
        color = color,
        trackColor = Nal.colors.surface3,
        strokeWidth = 2.dp,
    )
}

/** .state-row: a spinner and a line of text. */
@Composable
fun StateRow(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(vertical = 14.dp).semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        NalSpinner()
        Text(text, color = Nal.colors.text2, style = MaterialTheme.typography.bodyMedium)
    }
}

/** .state-card: a rounded surface; [error] tints it with the danger ground. */
@Composable
fun StateCard(
    modifier: Modifier = Modifier,
    error: Boolean = false,
    bordered: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Nal.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Nal.radius))
            .background(if (error) c.dangerBg else c.surface)
            .then(if (bordered) Modifier.border(1.dp, c.line, RoundedCornerShape(Nal.radius)) else Modifier)
            .padding(if (bordered) 16.dp else 22.dp),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
}

@Composable
fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier.padding(top = 18.dp, bottom = 6.dp), style = NalText.fieldLabel, color = Nal.colors.text2)
}

@Composable
fun FieldHint(text: String, modifier: Modifier = Modifier, align: TextAlign = TextAlign.Start, color: Color = Nal.colors.text2) {
    Text(text, modifier = modifier.fillMaxWidth().padding(top = 8.dp), style = NalText.hint, color = color, textAlign = align)
}

/** .form-status: nothing when empty, the danger colour for an error. Announced politely. */
@Composable
fun FormStatus(text: String?, modifier: Modifier = Modifier, error: Boolean = false) {
    if (text.isNullOrEmpty()) return
    Text(
        text,
        modifier = modifier.padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
        style = NalText.status,
        color = if (error) Nal.colors.danger else Nal.colors.text2,
    )
}

/** label.check: a 44dp row with a box, a title and an optional small explanation. */
@Composable
fun NalCheck(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    title: String,
    modifier: Modifier = Modifier,
    small: String? = null,
    enabled: Boolean = true,
) {
    val c = Nal.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(8.dp))
            .toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = onCheckedChange),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Checkbox(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
            modifier = Modifier.padding(top = 2.dp).size(22.dp),
            colors = CheckboxDefaults.colors(checkedColor = c.accent, checkmarkColor = c.onAccent, uncheckedColor = c.text3),
        )
        Column(Modifier.weight(1f)) {
            Text(title, color = c.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
            if (small != null) Text(small, color = c.text2, style = NalText.hint, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

@Composable
private fun fieldColors() = Nal.colors.let { c ->
    OutlinedTextFieldDefaults.colors(
        focusedContainerColor = c.surface, unfocusedContainerColor = c.surface, disabledContainerColor = c.surface2,
        focusedBorderColor = c.accentInk, unfocusedBorderColor = c.line, errorBorderColor = c.danger,
        focusedTextColor = c.text, unfocusedTextColor = c.text, disabledTextColor = c.text2,
        cursorColor = c.accentInk, focusedPlaceholderColor = c.text3, unfocusedPlaceholderColor = c.text3,
    )
}

/** input / textarea: surface ground, line border, accent ring on focus. */
@Composable
fun NalTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    isError: Boolean = false,
    mono: Boolean = false,
    contentDescription: String? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .fillMaxWidth()
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
        placeholder = placeholder?.let { { Text(it) } },
        singleLine = singleLine,
        minLines = minLines,
        enabled = enabled,
        readOnly = readOnly,
        isError = isError,
        shape = RoundedCornerShape(Nal.radiusSmall),
        colors = fieldColors(),
        textStyle = MaterialTheme.typography.bodyLarge.copy(
            fontFamily = if (mono) androidx.compose.ui.text.font.FontFamily.Monospace else null,
            fontSize = if (mono) 14.sp else 16.sp,
        ),
        keyboardOptions = keyboardOptions,
        visualTransformation = visualTransformation,
    )
}

/** select: a field-shaped button that opens a menu of [options] (value to label). */
@Composable
fun NalSelect(
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    val c = Nal.colors
    var open by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.first == selected }?.second ?: selected
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(Nal.radiusSmall))
                .background(c.surface)
                .border(1.dp, c.line, RoundedCornerShape(Nal.radiusSmall))
                .clickable(role = Role.DropdownList, onClickLabel = label) { open = true }
                .semantics { if (label != null) contentDescription = "$label: $current" }
                .padding(start = 14.dp, end = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(current, Modifier.weight(1f), color = c.text, style = MaterialTheme.typography.bodyLarge)
            Icon(Icons.Rounded.ExpandMore, contentDescription = null, tint = c.text3)
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = c.surface2,
            shape = RoundedCornerShape(Nal.radiusSmall),
        ) {
            for ((value, text) in options) {
                DropdownMenuItem(
                    text = { Text(text, fontWeight = if (value == selected) FontWeight.Bold else FontWeight.Normal) },
                    onClick = { open = false; onSelect(value) },
                    modifier = Modifier.heightIn(min = 44.dp),
                )
            }
        }
    }
}

/**
 * dialog.sheet: rises from the bottom, 28dp corners, a grab handle, a title and
 * a close button, a scrolling body and an optional fixed footer. One at a time
 * is the caller's business; back and a tap on the scrim close it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NalSheet(
    title: String,
    onDismiss: () -> Unit,
    footer: (@Composable RowScope.() -> Unit)? = null,
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Nal.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        sheetMaxWidth = Nal.column,
        shape = RoundedCornerShape(topStart = Nal.sheetRadius, topEnd = Nal.sheetRadius),
        containerColor = c.surface,
        contentColor = c.text,
        scrimColor = c.scrim,
        dragHandle = {
            Box(Modifier.padding(top = 10.dp, bottom = 2.dp).size(width = 40.dp, height = 4.dp).clip(CircleShape).background(c.surface3))
        },
    ) {
        val toaster = LocalToaster.current
        val level = rememberSheetLevel(toaster)
        Box(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                IconButton(onClick = onDismiss, modifier = Modifier.size(44.dp)) {
                    Icon(Icons.Rounded.Close, contentDescription = "Close", tint = c.text2)
                }
            }
            Column(
                Modifier
                    .weight(1f, fill = false)
                    .then(if (scrollable) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 16.dp),
                content = content,
            )
            if (footer != null) {
                HorizontalDivider(color = c.line)
                Row(
                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    content = footer,
                )
            }
        }
        if (toaster != null) {
            ToastHost(
                toaster, level,
                Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = if (footer != null) 80.dp else 16.dp),
            )
        }
        }
    }
}

/** Content capped at [Nal.column] and centred: the web's `#views { max-width: var(--column) }`. */
@Composable
fun CenteredColumn(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = Nal.column).fillMaxWidth(), content = content)
    }
}

/** The quoted note in a composer or a confirmation (.compose-parent). */
@Composable
fun QuoteBox(name: String, text: String, modifier: Modifier = Modifier) {
    val c = Nal.colors
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Nal.radiusSmall)).background(c.surface2).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(name, color = c.text, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        Text(
            text.trim().take(400).ifEmpty { "(no text)" },
            color = c.text2, fontSize = 14.sp, lineHeight = 20.sp, maxLines = 3,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        )
    }
}

/** A thin bordered chip (.starter). */
@Composable
fun NalChip(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, contentDescription: String? = null) {
    val c = Nal.colors
    Box(
        modifier
            .heightIn(min = 36.dp)
            .clip(CircleShape)
            .background(c.surface2)
            .border(BorderStroke(1.dp, c.line), CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = c.text2, fontSize = 14.sp) }
}
