package today.cypherpunk.nalgorithm.byok

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import today.cypherpunk.nalgorithm.ui.theme.Nal

// ─── Feed header: the empty states of bring-your-own-key mode ───────────────

/** "Three things before I can rank" with its steps, or "Nothing to rank yet" (web showEmptyState). */
@Composable
internal fun ByokFeedHeader(c: ByokController, modifier: Modifier) {
    val card by c.emptyCard.collectAsState()
    val state by c.feed.state.collectAsState()
    val saved by c.settings.collectAsState()
    val shown = card ?: return
    if (state.posts.isNotEmpty()) return
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Surface(
            color = Nal.colors.surface,
            shape = RoundedCornerShape(Nal.radius),
            modifier = Modifier.widthIn(max = Nal.column).fillMaxWidth().padding(horizontal = Nal.gutter, vertical = 8.dp),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (shown.configured) "Nothing to rank yet" else "Three things before I can rank",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = Nal.colors.text,
                )
                if (!shown.configured && shown.message == null) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SettingsValidation.setupSteps(saved).forEachIndexed { i, step -> SetupStepRow(i + 1, step) }
                    }
                }
                Text(
                    shown.message ?: if (shown.configured) {
                        "Press Refresh to load the people you follow and rank their posts."
                    } else {
                        "Everything runs on this phone; your key and settings stay on this device."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = Nal.colors.text2,
                )
                if (!shown.configured) {
                    Button(onClick = { c.goToTune() }) { Text("Finish setup") }
                }
            }
        }
    }
}

@Composable
private fun SetupStepRow(number: Int, step: SettingsValidation.Step) {
    val done = step.state == SettingsValidation.StepState.Done
    val next = step.state == SettingsValidation.StepState.Next
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(26.dp).background(
                when {
                    done -> Nal.colors.accent
                    next -> Nal.colors.hero
                    else -> Nal.colors.surface3
                },
                CircleShape,
            ),
            contentAlignment = Alignment.Center,
        ) {
            if (done) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = Nal.colors.onAccent, modifier = Modifier.size(16.dp))
            } else {
                Text("$number", color = if (next) Nal.colors.onHero else Nal.colors.text2, style = MaterialTheme.typography.labelMedium)
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(
            step.label + if (done) ": done" else "",
            color = if (done) Nal.colors.text3 else Nal.colors.text,
            fontWeight = if (next) FontWeight.SemiBold else FontWeight.Normal,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/** Nothing BYOK-specific sits under the digest list header; the web shows none either. */
@Composable
internal fun ByokDigestExtras(@Suppress("UNUSED_PARAMETER") c: ByokController, @Suppress("UNUSED_PARAMETER") modifier: Modifier) = Unit

// ─── Small Tune building blocks ──────────────────────────────────────────────

@Composable
internal fun FieldHint(text: String, isError: Boolean = false) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (isError) Nal.colors.danger else Nal.colors.text3)
}

/** A checkbox with a title and a small explanation (web `label.check`). */
@Composable
internal fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, title: String, hint: String? = null) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        Checkbox(checked = checked, onCheckedChange = onChange)
        Column(Modifier.padding(top = 12.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text)
            if (hint != null) FieldHint(hint)
        }
    }
}

/** A text field; [focus] lets a setup problem jump to it. */
@Composable
internal fun TextInput(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    placeholder: String = "",
    readOnly: Boolean = false,
    secret: Boolean = false,
    number: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    mono: Boolean = false,
    isError: Boolean = false,
    focus: FocusRequester? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    var reveal by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        placeholder = if (placeholder.isNotEmpty()) ({ Text(placeholder, color = Nal.colors.text3) }) else null,
        readOnly = readOnly,
        singleLine = singleLine,
        minLines = minLines,
        isError = isError,
        textStyle = if (mono) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
        visualTransformation = if (secret && !reveal) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = when {
                number -> KeyboardType.Number
                secret -> KeyboardType.Password
                else -> KeyboardType.Text
            },
            autoCorrectEnabled = false,
        ),
        trailingIcon = trailing ?: if (secret) ({
            IconButton(onClick = { reveal = !reveal }) {
                Icon(if (reveal) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, contentDescription = if (reveal) "Hide key" else "Show key")
            }
        }) else null,
        modifier = Modifier.fillMaxWidth().let { if (focus != null) it.focusRequester(focus) else it },
    )
}

/** A whole-number field; anything else reads as invalid so validation names the range. */
@Composable
internal fun NumberInput(label: String, value: Int, onChange: (Int) -> Unit, focus: FocusRequester? = null, modifier: Modifier = Modifier) {
    var text by remember(value) { mutableStateOf(if (value == Int.MIN_VALUE) "" else value.toString()) }
    Box(modifier) {
        TextInput(
            label = label,
            value = text,
            onChange = { t ->
                text = t
                onChange(t.trim().toIntOrNull() ?: Int.MIN_VALUE)
            },
            number = true,
            focus = focus,
        )
    }
}

/** A select (web `<select>`). */
@Composable
internal fun SelectInput(label: String, options: List<Pair<String, String>>, value: String, onSelect: (String) -> Unit, focus: FocusRequester? = null) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextInput(
            label = label,
            value = options.firstOrNull { it.first == value }?.second ?: value,
            onChange = {},
            readOnly = true,
            focus = focus,
            trailing = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) },
        )
        // The read-only field does not take taps itself; this layer opens the menu.
        Box(Modifier.matchParentSize().padding(top = 8.dp).clickable { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((key, text) in options) {
                DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onSelect(key) })
            }
        }
    }
}

/** A model field: free text, with the loaded catalog as suggestions (web `<datalist>`). */
@Composable
internal fun ModelInput(label: String, value: String, onChange: (String) -> Unit, placeholder: String, catalog: List<ModelInfo>, focus: FocusRequester? = null) {
    var open by remember { mutableStateOf(false) }
    val matches = remember(value, catalog) {
        val q = value.trim().lowercase()
        (if (q.isEmpty()) catalog else catalog.filter { it.id.lowercase().contains(q) }).take(60)
    }
    Box {
        TextInput(
            label = label,
            value = value,
            onChange = onChange,
            placeholder = placeholder,
            mono = true,
            focus = focus,
            trailing = if (catalog.isEmpty()) null else ({
                IconButton(onClick = { open = !open }) { Icon(Icons.Filled.ArrowDropDown, contentDescription = "Choose from the model list") }
            }),
        )
        DropdownMenu(expanded = open && matches.isNotEmpty(), onDismissRequest = { open = false }) {
            for (m in matches) {
                val about = ModelCatalog.describe(m)
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(m.id, fontFamily = FontFamily.Monospace)
                            if (about.isNotEmpty()) Text(about, style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
                        }
                    },
                    onClick = { open = false; onChange(m.id) },
                )
            }
        }
    }
}

/** A Tune card that opens and closes (web `<details class="tune-section">`). */
@Composable
internal fun CollapsibleSection(title: String, expanded: Boolean, onToggle: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = Nal.colors.surface, shape = RoundedCornerShape(Nal.radius), modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 20.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = Nal.colors.text, modifier = Modifier.weight(1f))
                Icon(if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, contentDescription = if (expanded) "Collapse" else "Expand", tint = Nal.colors.text2)
            }
            AnimatedVisibility(expanded) {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
            }
        }
    }
}
