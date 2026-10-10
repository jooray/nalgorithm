package today.cypherpunk.nalgorithm.nostr

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nostrsignin.SignInUtil
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

/**
 * Zap a note (NIP-57, external wallet), web: zap-ui.ts. One flow per note:
 *   1. find the author's Lightning address (lud16, else lud06) in their profile
 *   2. fetch the LNURL-pay parameters and check them (untrusted server)
 *   3. pick an amount and an optional comment
 *   4. sign a kind 9734 zap request, ask the server's callback for an invoice,
 *      check the invoice's amount and that it commits to our zap request
 *   5. hand the invoice to a wallet (lightning: link), with QR and copy
 *   6. watch the relays for the kind 9735 receipt, check it, and mark Zapped
 *
 * The flow lives in the app scope, so a receipt that arrives after the sheet
 * was closed still marks the note and says so in a toast.
 */
internal class ZapFlow(private val actions: NoteActions, val target: NoteActions.NoteTarget) {
    private val graph: AppGraph get() = actions.graphRef

    sealed interface Step {
        data object Signer : Step
        /** The reader backed out of connecting a signer. */
        data object Cancelled : Step
        data class Loading(val text: String) : Step
        data class Problem(val text: String, val address: String? = null, val retry: (() -> Unit)? = null) : Step
        data class Choose(val pay: NoteLogic.PayTarget, val params: NoteLogic.PayParams, val initialSats: Long, val busy: Boolean = false) : Step
        data class Invoice(val invoice: String, val sats: Long, val expired: Boolean = false, val pay: NoteLogic.PayTarget, val params: NoteLogic.PayParams) : Step
        data class Zapped(val sats: Long) : Step
    }

    private val _step = MutableStateFlow<Step>(Step.Signer)
    val step: StateFlow<Step> = _step.asStateFlow()

    @Volatile var finished = false
        private set
    @Volatile var sheetOpen = false
    private var job: Job? = null
    private var watch: RelaySubscription? = null
    private var expiryJob: Job? = null
    private var signer: NostrSigner? = null

    fun start() {
        if (job != null) return
        job = graph.scope.launch(Dispatchers.IO) {
            val s = actions.requireSigner()
            if (s == null) {
                _step.value = Step.Cancelled
                finish()
                return@launch
            }
            signer = s
            run()
        }
    }

    /** The sheet closed. Waiting for a receipt continues; anything earlier is dropped. */
    fun sheetClosed() {
        sheetOpen = false
        val step = _step.value
        if (step !is Step.Invoice || step.expired) {
            job?.cancel()
            finish()
        }
    }

    private fun finish() {
        finished = true
        watch?.close()
        watch = null
        expiryJob?.cancel()
        actions.zaps.remove(target.id, this)
    }

    private suspend fun run() {
        _step.value = Step.Loading("Looking up ${target.authorName}'s Lightning address…")
        val relays = actions.readRelaysFor(target.author, listOfNotNull(target.relay))
        val meta = actions.fetchMetadata(target.author, relays)
        val pay = meta?.let(NoteLogic::payTargetFromProfile)
        if (pay == null) {
            _step.value = Step.Problem(
                if (meta != null) {
                    "${target.authorName} has no Lightning address on their profile, so there is nowhere to send a zap."
                } else {
                    "I could not load ${target.authorName}'s profile from your relays, so I cannot find where to send a zap."
                },
                retry = if (meta == null) ({ relaunch { run() } }) else null,
            )
            return
        }
        _step.value = Step.Loading("Asking ${pay.label} for zap details…")
        val params = try {
            when (val parsed = NoteLogic.parsePayParams(fetchJson(pay.url))) {
                is NoteLogic.Checked.Fail -> {
                    _step.value = Step.Problem(parsed.error, pay.address)
                    return
                }
                is NoteLogic.Checked.Ok -> parsed.value
            }
        } catch (e: LnurlException) {
            _step.value = Step.Problem(e.message ?: "", pay.address, retry = { relaunch { run() } })
            return
        }
        choose(pay, params)
    }

    private suspend fun choose(pay: NoteLogic.PayTarget, params: NoteLogic.PayParams) {
        _step.value = Step.Choose(pay, params, lastAmount())
    }

    private fun relaunch(block: suspend () -> Unit) {
        job?.cancel()
        job = graph.scope.launch(Dispatchers.IO) { block() }
    }

    fun backToAmount() {
        val s = _step.value
        if (s is Step.Invoice) relaunch { choose(s.pay, s.params) }
    }

    fun zap(pay: NoteLogic.PayTarget, params: NoteLogic.PayParams, sats: Long, comment: String) {
        val check = NoteLogic.checkAmount(params.minSendable, params.maxSendable, sats.toDouble())
        if (check !is NoteLogic.Checked.Ok) return
        val choose = _step.value as? Step.Choose ?: return
        _step.value = choose.copy(busy = true)
        relaunch {
            try {
                requestInvoice(pay, params, check.value, comment)
                rememberAmount(sats)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _step.value = Step.Problem(
                    e.message ?: e.toString(),
                    address = if (e is LnurlException && e.blocked) pay.address else null,
                    retry = { relaunch { choose(pay, params) } },
                )
            }
        }
    }

    private suspend fun requestInvoice(pay: NoteLogic.PayTarget, params: NoteLogic.PayParams, msats: Long, comment: String) {
        val signer = signer ?: throw IllegalStateException("No signer.")
        val own = actions.getRelayList(signer.pubkey)
        val zapRelays = ((own?.read ?: emptyList()) + actions.defaultRelays() + NoteActions.INDEXER_RELAYS.take(1)).distinct().take(6)
        val template = NoteLogic.zapRequestTemplate(target.author, target.id, target.event?.kind ?: target.kind, msats, zapRelays, pay.lnurl, comment)
        val zapRequest = signChecked(signer, template)
        val zapRequestJson = zapRequest.toJsonString()
        val reply = fetchJson(NoteLogic.buildInvoiceUrl(params.callback, params.commentAllowed, msats, zapRequestJson, pay.lnurl, comment)) as? JsonObject
            ?: throw LnurlException("The Lightning server did not send an invoice.")
        if ((reply["status"] as? JsonPrimitive)?.contentOrNull == "ERROR") {
            val reason = (reply["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.replace(Regex("\\s+"), " ")?.take(200).orEmpty()
            throw LnurlException("The Lightning server refused: ${reason.ifEmpty { "no reason given" }}.")
        }
        val checked = NoteLogic.validateInvoice(reply["pr"], msats, zapRequestJson)
        if (checked is NoteLogic.Checked.Fail) throw LnurlException(checked.error)
        val decoded = (checked as NoteLogic.Checked.Ok).value
        val invoice = (reply["pr"] as JsonPrimitive).content.trim().lowercase()
        val sats = msats / 1000
        _step.value = Step.Invoice(invoice, sats, pay = pay, params = params)
        watchReceipt(zapRequest, zapRequestJson, params.nostrPubkey, invoice, sats, decoded.timestamp + decoded.expiry, signer.pubkey)
    }

    private fun watchReceipt(zapRequest: NostrEvent, zapRequestJson: String, nostrPubkey: String, invoice: String, sats: Long, expiresAt: Long, reader: String) {
        watch?.close()
        expiryJob?.cancel()
        val relays = zapRequest.tags.firstOrNull { it.getOrNull(0) == "relays" }?.drop(1)?.ifEmpty { null } ?: actions.defaultRelays()
        val filter = Filter(kinds = listOf(9735), p = listOf(target.author), e = listOf(target.id), since = zapRequest.createdAt - 30)
        var done = false
        watch = graph.relayPool.open(relays, listOf(filter)) { receipt ->
            synchronized(this) {
                if (done) return@open
                val ok = NoteLogic.validateReceipt(receipt, zapRequest, zapRequestJson, nostrPubkey, invoice)
                if (ok !is NoteLogic.Checked.Ok) return@open
                done = true
            }
            graph.scope.launch {
                actions.markZapped(reader, target.id, sats)
                if (sheetOpen) {
                    _step.value = Step.Zapped(sats)
                } else {
                    graph.toasts.show("Zapped ${NoteLogic.formatEn(sats)} sats to ${target.authorName}.")
                }
                finish()
            }
        }
        // Stop watching a couple of minutes after the invoice can no longer be paid.
        val secondsLeft = (expiresAt - nowSeconds()).coerceAtLeast(0)
        expiryJob = graph.scope.launch {
            delay((secondsLeft + WATCH_GRACE_S) * 1000)
            watch?.close()
            watch = null
            val s = _step.value
            if (s is Step.Invoice) _step.value = s.copy(expired = true)
            if (!sheetOpen) finish()
        }
    }

    // ─── LNURL fetch ─────────────────────────────────────────────────────────

    class LnurlException(message: String, val blocked: Boolean = false) : Exception(message)

    private val client by lazy {
        graph.http.newBuilder()
            .callTimeout(LNURL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .build()
    }

    private suspend fun fetchJson(url: String): JsonElement = withContext(Dispatchers.IO) {
        val host = url.toHttpUrlOrNull()?.host ?: url
        val request = Request.Builder().url(url).header("Accept", "application/json").build()
        val response = try {
            client.newCall(request).execute()
        } catch (e: InterruptedIOException) {
            throw LnurlException("$host did not answer in time.", true)
        } catch (e: IOException) {
            throw LnurlException("I could not reach $host. Check your connection, then try again.", true)
        }
        response.use { r ->
            if (!r.isSuccessful) throw LnurlException("$host answered with an error (${r.code}).")
            val body = r.body
            val bytes = try {
                body.byteStream().use { readAtMost(it, MAX_RESPONSE_CHARS * 4 + 1) }
            } catch (e: IOException) {
                throw LnurlException("$host did not answer in time.", true)
            }
            val text = String(bytes, Charsets.UTF_8)
            if (text.length > MAX_RESPONSE_CHARS || bytes.size > MAX_RESPONSE_CHARS * 4) throw LnurlException("$host sent an oversized response.")
            runCatching { relayJson.parseToJsonElement(text) }.getOrNull() ?: throw LnurlException("$host did not send a valid response.")
        }
    }

    private fun readAtMost(input: java.io.InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < limit) {
            val n = input.read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private suspend fun lastAmount(): Long {
        val n = runCatching { graph.records.getRaw(AMOUNT_KEY)?.toLongOrNull() }.getOrNull()
        return if (n != null && n > 0) n else 21
    }

    private suspend fun rememberAmount(sats: Long) {
        runCatching { graph.records.putRaw(AMOUNT_KEY, sats.toString()) }
    }

    companion object {
        val PRESETS = listOf(21L, 100L, 1000L, 5000L)
        private const val AMOUNT_KEY = "zap:amount"
        const val MAX_COMMENT = 200
        private const val LNURL_TIMEOUT_MS = 9_000L
        private const val MAX_RESPONSE_CHARS = 20_000
        private const val WATCH_GRACE_S = 120L
    }
}

/** The zap flow for one note: amount, comment, invoice, wallet hand-off. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ZapSheet(graph: AppGraph, post: ScoredPost, onDismiss: () -> Unit) {
    val flow = remember(post.id) { graph.noteActions.zapFlow(post) }
    DisposableEffect(flow) {
        flow.sheetOpen = true
        flow.start()
        onDispose { flow.sheetClosed() }
    }
    val step by flow.step.collectAsState()
    // Nothing to show while the signer sheet is up; a reader who backs out there closes this too.
    LaunchedEffect(step) {
        if (step is ZapFlow.Step.Cancelled) onDismiss()
    }
    if (step is ZapFlow.Step.Signer || step is ZapFlow.Step.Cancelled) return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = Nal.colors.surface) {
        Column(
            Modifier
                .fillMaxWidth()
                .wrapContentWidth(Alignment.CenterHorizontally)
                .widthIn(max = Nal.column)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Nal.gutter)
                .padding(bottom = 24.dp)
                .navigationBarsPadding(),
        ) {
            Text("Zap ${flow.target.authorName}", style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
            Spacer(Modifier.height(12.dp))
            when (val s = step) {
                ZapFlow.Step.Signer, ZapFlow.Step.Cancelled -> Unit
                is ZapFlow.Step.Loading -> Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2)
                is ZapFlow.Step.Problem -> ZapProblem(s)
                is ZapFlow.Step.Choose -> ChooseAmount(flow, s, onCancel = onDismiss)
                is ZapFlow.Step.Invoice -> ShowInvoice(flow, s)
                is ZapFlow.Step.Zapped -> Zapped(s.sats, flow.target.authorName, onDone = onDismiss)
            }
        }
    }
}

@Composable
private fun ZapProblem(s: ZapFlow.Step.Problem) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf<Boolean?>(null) }
    Text(
        s.text,
        style = MaterialTheme.typography.bodyMedium,
        color = Nal.colors.danger,
        modifier = Modifier
            .fillMaxWidth()
            .background(Nal.colors.dangerBg, RoundedCornerShape(Nal.radiusSmall))
            .padding(12.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
    )
    s.address?.let { addr ->
        Spacer(Modifier.height(10.dp))
        Text("You can still zap from your wallet with this address:", style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2)
        Text(addr, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), color = Nal.colors.text)
    }
    Spacer(Modifier.height(14.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        s.address?.let { addr ->
            OutlinedButton(onClick = {
                copied = copyToClipboard(context, addr)
                scope.launch {
                    delay(1400)
                    copied = null
                }
            }) { Text(when (copied) { true -> "Copied"; false -> "Copy failed"; null -> "Copy Lightning address" }) }
            Spacer(Modifier.size(8.dp))
        }
        s.retry?.let { retry -> Button(onClick = retry) { Text("Try again") } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChooseAmount(flow: ZapFlow, s: ZapFlow.Step.Choose, onCancel: () -> Unit) {
    val minSats = kotlin.math.ceil(s.params.minSendable / 1000)
    val maxSats = kotlin.math.floor(s.params.maxSendable / 1000)
    var sats by remember(s.pay) { mutableStateOf(s.initialSats.toDouble()) }
    var custom by remember(s.pay) { mutableStateOf(if (s.initialSats in ZapFlow.PRESETS) "" else s.initialSats.toString()) }
    var comment by remember(s.pay) { mutableStateOf("") }
    val check = if (sats.isFinite()) NoteLogic.checkAmount(s.params.minSendable, s.params.maxSendable, sats) else null
    val enabled = !s.busy

    Text("Send sats to ${s.pay.label}", style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text)
    Spacer(Modifier.height(10.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.semantics { contentDescription = "Amount in sats" }) {
        for (n in ZapFlow.PRESETS) {
            FilterChip(
                selected = sats == n.toDouble() && custom.isEmpty(),
                onClick = {
                    custom = ""
                    sats = n.toDouble()
                },
                enabled = enabled,
                label = { Text(NoteLogic.formatEn(n)) },
            )
        }
    }
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = custom,
        onValueChange = { v ->
            custom = v.filter { it.isDigit() }.take(12)
            sats = if (custom.isEmpty()) Double.NaN else custom.toDouble()
        },
        label = { Text("Or your own amount, in sats") },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth(),
    )
    Text(
        "This address accepts ${NoteLogic.formatEn(minSats)} to ${NoteLogic.formatEn(maxSats)} sats.",
        style = MaterialTheme.typography.bodySmall,
        color = Nal.colors.text3,
        modifier = Modifier.padding(top = 6.dp),
    )
    if (check is NoteLogic.Checked.Fail) {
        Text(check.error, style = MaterialTheme.typography.bodySmall, color = Nal.colors.danger, modifier = Modifier.padding(top = 4.dp).semantics { liveRegion = LiveRegionMode.Assertive })
    }
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = comment,
        onValueChange = { comment = it.take(ZapFlow.MAX_COMMENT) },
        label = { Text("Comment (optional)") },
        enabled = enabled,
        minLines = 2,
        modifier = Modifier.fillMaxWidth(),
    )
    if (s.busy) {
        Text(
            "Waiting for your signer to sign the zap request…",
            style = MaterialTheme.typography.bodyMedium,
            color = Nal.colors.text2,
            modifier = Modifier.padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    Spacer(Modifier.height(14.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onCancel, enabled = enabled) { Text("Cancel") }
        Spacer(Modifier.size(8.dp))
        Button(
            onClick = { flow.zap(s.pay, s.params, sats.toLong(), comment) },
            enabled = enabled && check is NoteLogic.Checked.Ok,
        ) { Text(if (check is NoteLogic.Checked.Ok) "Zap ${NoteLogic.formatEn(sats.toLong())} sats" else "Zap") }
    }
}

@Composable
private fun ShowInvoice(flow: ZapFlow, s: ZapFlow.Step.Invoice) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf<Boolean?>(null) }
    var walletProblem by remember { mutableStateOf(false) }
    val qr = remember(s.invoice) { runCatching { SignInUtil.qrBitmap(s.invoice.uppercase(), 720).asImageBitmap() }.getOrNull() }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("${NoteLogic.formatEn(s.sats)} sats to ${flow.target.authorName}", style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text)
        Spacer(Modifier.height(10.dp))
        if (qr != null) {
            Box(Modifier.background(Color.White, RoundedCornerShape(Nal.radiusSmall)).padding(10.dp)) {
                Image(qr, contentDescription = "Lightning invoice QR code", modifier = Modifier.size(240.dp))
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            if (s.expired) {
                "The invoice expired before a receipt arrived. If you paid, the receipt may still show up later; otherwise create a new one."
            } else {
                "Waiting for the payment. This turns to Zapped when the receipt arrives."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = Nal.colors.text2,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (walletProblem) {
            Text(
                "No app on this phone opens Lightning invoices. Copy the invoice into your wallet, or scan the code from another device.",
                style = MaterialTheme.typography.bodySmall,
                color = Nal.colors.danger,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        Spacer(Modifier.height(14.dp))
        if (s.expired) {
            Button(onClick = { flow.backToAmount() }, modifier = Modifier.fillMaxWidth()) { Text("New invoice") }
        } else {
            Button(
                onClick = {
                    walletProblem = try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("lightning:${s.invoice}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        false
                    } catch (e: ActivityNotFoundException) {
                        true
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Open in wallet") }
            OutlinedButton(
                onClick = {
                    copied = copyToClipboard(context, s.invoice)
                    scope.launch {
                        delay(1400)
                        copied = null
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(when (copied) { true -> "Copied"; false -> "Copy failed"; null -> "Copy invoice" }) }
        }
    }
}

@Composable
internal fun SentHeader(title: String, line: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Nal.colors.accentInk, modifier = Modifier.size(30.dp))
        Spacer(Modifier.size(12.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, color = Nal.colors.text)
            Text(line, style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}

@Composable
private fun Zapped(sats: Long, authorName: String, onDone: () -> Unit) {
    SentHeader("Zapped", "${NoteLogic.formatEn(sats)} sats reached $authorName.")
    Spacer(Modifier.height(16.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Button(onClick = onDone) { Text("Done") }
    }
}
