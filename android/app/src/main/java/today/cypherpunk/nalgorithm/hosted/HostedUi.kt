package today.cypherpunk.nalgorithm.hosted

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import today.cypherpunk.nalgorithm.R
import today.cypherpunk.nalgorithm.nostr.SignInPanel
import today.cypherpunk.nalgorithm.nostr.SignInPurpose
import today.cypherpunk.nalgorithm.ui.theme.Nal

// ─── Shared bits ─────────────────────────────────────────────────────────────

@Composable
internal fun StatusText(status: HostedController.Status, modifier: Modifier = Modifier) {
    if (status.text.isEmpty()) return
    Text(
        status.text,
        modifier = modifier.padding(top = 6.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = if (status.isError) Nal.colors.danger else Nal.colors.text2,
    )
}

@Composable
internal fun Hint(text: String, modifier: Modifier = Modifier) {
    if (text.isEmpty()) return
    Text(text, modifier = modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3)
}

/** A rounded card like the web's `.state-card`; [error] gives it the danger tint. */
@Composable
internal fun StateCard(modifier: Modifier = Modifier, error: Boolean = false, warn: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val c = Nal.colors
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Nal.radius),
        color = when {
            error -> c.dangerBg
            warn -> c.warnBg
            else -> c.surface
        },
        border = BorderStroke(1.dp, if (error) c.danger.copy(alpha = 0.35f) else c.line),
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

/** The page column: never wider than [Nal.column], centered on a wide screen. */
@Composable
internal fun CappedColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = Nal.column).fillMaxWidth(), content = content)
    }
}

// ─── Gate: login, startup error ──────────────────────────────────────────────

@Composable
internal fun HostedGate(c: HostedController, modifier: Modifier) {
    val gate by c.gate.collectAsState()
    Box(modifier.fillMaxSize().background(Nal.colors.bg)) {
        when (gate) {
            HostedController.GateState.Booting -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            HostedController.GateState.Login -> GateColumn { LoginGate(c) }
            HostedController.GateState.Startup -> GateColumn { StartupGate(c) }
            HostedController.GateState.None -> Unit
        }
    }
}

@Composable
private fun GateColumn(content: @Composable ColumnScope.() -> Unit) {
    CappedColumn(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.padding(horizontal = Nal.gutter, vertical = 32.dp), content = content)
    }
}

@Composable
private fun GateTitle(text: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Nal.colors.text)
}

@Composable
private fun ColumnScope.LoginGate(c: HostedController) {
    val status by c.loginStatus.collectAsState()
    val busy by c.signingIn.collectAsState()
    Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(72.dp).align(Alignment.CenterHorizontally))
    Spacer(Modifier.height(8.dp))
    GateTitle("Sign in with your Nostr key.")
    Text(
        "No API key: 3-day free trial, then 10,000 sats per 30 days. Your signer proves your identity. Remote signers also connect for replies, boosts, likes and zap requests; nothing is published unless you choose an action.",
        modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
        style = MaterialTheme.typography.bodyLarge,
        color = Nal.colors.text2,
    )
    SignInPanel(c.graph.signers, SignInPurpose.HostedLogin, onResult = c::signIn, modifier = Modifier.fillMaxWidth())
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 12.dp))
    StatusText(status)
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = c::useOwnKey, modifier = Modifier.fillMaxWidth()) { Text("Use my own API key instead (free)") }
}

@Composable
private fun ColumnScope.StartupGate(c: HostedController) {
    val error by c.startupError.collectAsState()
    GateTitle("Could not open your account.")
    Text(error, modifier = Modifier.padding(top = 8.dp, bottom = 16.dp), style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text2)
    Button(onClick = c::boot, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
    OutlinedButton(onClick = c::useOwnKey, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Use my own model key") }
}

// ─── Feed header: banner, status, notice, paywall, loading, empty ────────────

@Composable
internal fun HostedFeedHeader(c: HostedController, modifier: Modifier) {
    val ent by c.entitlement.collectAsState()
    val statusLine by c.statusLine.collectAsState()
    val notice by c.notice.collectAsState()
    val paywall by c.paywall.collectAsState()
    val loading by c.loadingText.collectAsState()
    val empty by c.empty.collectAsState()
    val device by c.graph.deviceSettings.settings.collectAsState()

    CappedColumn(modifier) {
        // The feed list is edge to edge; its rows keep the 16dp gutter themselves.
        Column(Modifier.padding(horizontal = Nal.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ent?.let { e ->
                val view = entitlementView(e, System.currentTimeMillis() / 1000)
                if (view.banner) Banner(view) { c.showPaywall() }
            }
            when (val s = statusLine) {
                is HostedController.StatusLine.Text -> Hint(s.text)
                is HostedController.StatusLine.Coverage -> Hint(coverageText(s.shown, s.ranked, s.hoursBack, device.feedOrder))
                null -> Unit
            }
            notice?.let { n ->
                StateCard(error = true) {
                    Text(n.text, color = Nal.colors.text)
                    if (n.actionLabel != null && n.action != null) {
                        OutlinedButton(onClick = n.action, modifier = Modifier.padding(top = 10.dp)) { Text(n.actionLabel) }
                    }
                }
            }
            if (paywall) Paywall(c)
            loading?.let { text ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text(text, modifier = Modifier.padding(start = 12.dp), color = Nal.colors.text2, style = MaterialTheme.typography.bodyMedium)
                }
            }
            empty?.let { e ->
                StateCard {
                    Text(e.text, color = Nal.colors.text)
                    if (e.firstRun) {
                        Button(onClick = c::focusPromptField, modifier = Modifier.padding(top = 10.dp)) { Text("Write what you care about") }
                    }
                }
            }
        }
    }
}

@Composable
private fun Banner(view: EntitlementView, onAction: () -> Unit) {
    val c = Nal.colors
    val (bg, fg) = when (view.kind) {
        "expired" -> c.dangerBg to c.danger
        "unknown" -> c.warnBg to c.warn
        else -> c.surface2 to c.text
    }
    Surface(shape = RoundedCornerShape(Nal.radiusSmall), color = bg, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(view.text, color = fg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if (view.actionLabel != null) {
                TextButton(onClick = onAction) { Text(view.actionLabel) }
            }
        }
    }
}

@Composable
private fun Paywall(c: HostedController) {
    val plan by c.plan.collectAsState()
    val sats by c.satsText.collectAsState()
    val status by c.payStatus.collectAsState()
    val paying by c.paying.collectAsState()
    val link by c.payLink.collectAsState()
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    StateCard {
        Text("Keep your morning going", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = Nal.colors.text)
        Text(
            "Pay any amount over Lightning. It is credited by the day, and unused trial days are kept.",
            modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
            color = Nal.colors.text2,
        )
        Text("Plan", style = MaterialTheme.typography.labelLarge, color = Nal.colors.text2)
        for (p in Plan.entries) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .clickable(role = Role.RadioButton) { c.selectPlan(p) }
                    .background(if (p == plan) Nal.colors.surface2 else Nal.colors.surface, RoundedCornerShape(Nal.radiusSmall))
                    .padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = p == plan, onClick = { c.selectPlan(p) })
                Column(Modifier.padding(start = 4.dp)) {
                    Text(p.label, fontWeight = FontWeight.Bold, color = Nal.colors.text)
                    Text(p.blurb, style = MaterialTheme.typography.bodySmall, color = Nal.colors.text2)
                }
            }
        }
        OutlinedTextField(
            value = sats,
            onValueChange = { c.satsText.value = it.filter { ch -> !ch.isWhitespace() }.take(12) },
            label = { Text("Amount in sats (minimum 1,000)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
        Hint(payDaysText(plan, sats))
        Button(onClick = { c.startPayment(context) }, enabled = !paying, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
            Text("Pay with Lightning")
        }
        StatusText(status)
        link?.let { url ->
            TextButton(onClick = { c.openPaymentPage(context, url) }) { Text("Payment page not open? Open it here") }
            OutlinedButton(onClick = c::cancelPayment, modifier = Modifier.fillMaxWidth()) { Text("Stop waiting") }
        }
        TextButton(onClick = { runCatching { uri.openUri(TERMS_URL) } }) { Text("Terms, refunds and support") }
    }
}

// ─── Digests tab: schedule line and the one nudge ────────────────────────────

@Composable
internal fun HostedDigestExtras(c: HostedController, modifier: Modifier) {
    val schedule by c.schedule.collectAsState()
    val nudge by c.nudge.collectAsState()
    val nudgeStatus by c.nudgeStatus.collectAsState()
    val saving by c.nudgeSaving.collectAsState()
    val line = scheduleLine(schedule)
    CappedColumn(modifier) {
        if (line.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(line, style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2, modifier = Modifier.weight(1f, fill = false))
                if (schedule?.enabled == false) TextButton(onClick = c::openScheduleSettings) { Text("Set daily delivery") }
            }
        }
        nudge?.let { text ->
            StateCard(Modifier.padding(top = 8.dp)) {
                Text("Have this ready tomorrow at $NUDGE_TIME?", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Nal.colors.text)
                Text(text, modifier = Modifier.padding(top = 6.dp), color = Nal.colors.text2)
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = c::acceptScheduleNudge, enabled = !saving) { Text("Set daily delivery") }
                    TextButton(onClick = c::dismissScheduleNudge) { Text("Not now") }
                }
                StatusText(nudgeStatus)
            }
        }
    }
}

@Composable
internal fun DangerButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Nal.colors.danger),
        border = BorderStroke(1.dp, Nal.colors.danger.copy(alpha = 0.6f)),
    ) { Text(text, textAlign = TextAlign.Center) }
}
