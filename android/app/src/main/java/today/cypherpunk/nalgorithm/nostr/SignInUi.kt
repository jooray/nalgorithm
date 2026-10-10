package today.cypherpunk.nalgorithm.nostr

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nostrsignin.Nip55
import today.cypherpunk.nostrsignin.SignInUtil

/** The sheet title for a purpose (login-ui.ts). */
fun signInTitle(purpose: SignInPurpose): String = when (purpose) {
    SignInPurpose.Actions -> "Connect a signer"
    SignInPurpose.HostedLogin -> "Sign in to hosted Nalgorithm"
    SignInPurpose.ByokIdentity -> "Connect your Nostr identity"
}

/** The notice under the title (login-ui.ts READONLY/HOSTED/ACTIONS_NOTICE), lead in bold. */
fun signInNotice(purpose: SignInPurpose): AnnotatedString {
    val (lead, rest) = when (purpose) {
        SignInPurpose.Actions -> "You choose every post." to
            " Nalgorithm asks your signer to sign a reply, boost, like or zap only when you tap it. Nothing is sent on its own. A remote signer stays connected on this device until you sign out."
        SignInPurpose.HostedLogin -> "Nothing is posted on its own." to
            " Signing in asks your signer to sign a one-time login event for nalgorithm, which is never published. A remote signer is also asked to allow replies, boosts, likes and zaps, which Nalgorithm signs only when you tap them, so you connect once. No API key is involved."
        SignInPurpose.ByokIdentity -> "Read-only." to
            " Nalgorithm only needs your public key, so it can read your follow list, your feed, and your likes. It never signs, posts, or reacts during identity connection. If you choose a note action later, you will connect a signer and approve posting permissions then."
    }
    return buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(lead) }
        append(rest)
    }
}

/** npub1abcdefgh…uvwxyz, for sentences (note-ui.ts short()). */
internal fun shortNpub(npub: String): String = if (npub.length > 20) "${npub.take(12)}…${npub.takeLast(6)}" else npub

internal fun copyToClipboard(context: Context, text: String): Boolean = runCatching {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Nalgorithm", text))
    true
}.getOrDefault(false)

internal fun openCustomTab(context: Context, url: String): Boolean = runCatching {
    CustomTabsIntent.Builder().build().apply { intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) }.launchUrl(context, Uri.parse(url))
    true
}.getOrDefault(false)

/** The sheet [SignerManager.requestSigner] asks for. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SignInSheet(manager: SignerManager) {
    val request by manager.sheet.collectAsState()
    val req = request ?: return
    key(req) {
        var asking by remember { mutableStateOf(req.purpose == SignInPurpose.Actions) }
        var problem by remember { mutableStateOf<String?>(null) }
        var attempt by remember { mutableIntStateOf(0) }
        val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { manager.finishSheet(req, null) },
            sheetState = state,
            containerColor = Nal.colors.surface,
        ) {
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
                if (asking) {
                    AskForSigner(req.expectedPubkey, problem, onNotNow = { manager.finishSheet(req, null) }, onChoose = {
                        asking = false
                        attempt++
                    })
                } else {
                    Text(signInTitle(req.purpose), style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
                    Spacer(Modifier.height(12.dp))
                    if (problem != null && req.purpose != SignInPurpose.Actions) ProblemText(problem!!)
                    key(attempt) {
                        SignInPanelContent(manager, req.purpose, onResult = { result ->
                            val expected = req.expectedPubkey
                            if (expected != null && result.pubkey != expected) {
                                result.signer?.close()
                                problem = "That signer belongs to ${shortNpub(Nip19.npub(result.pubkey).ifEmpty { "another key" })}, not to the key you are signed in with. Connect the matching one."
                                if (req.purpose == SignInPurpose.Actions) asking = true else attempt++
                            } else {
                                manager.finishSheet(req, result)
                            }
                        })
                    }
                }
            }
        }
    }
}

/** web: note-ui.ts askForSigner. */
@Composable
private fun AskForSigner(reader: String?, problem: String?, onNotNow: () -> Unit, onChoose: () -> Unit) {
    Text("Sign in with a signer", style = MaterialTheme.typography.titleLarge, color = Nal.colors.text)
    Spacer(Modifier.height(12.dp))
    Text("Sign in with a signer to reply, boost, like or zap.", style = MaterialTheme.typography.bodyLarge, color = Nal.colors.text)
    Spacer(Modifier.height(8.dp))
    val npub = reader?.let(Nip19::npub).orEmpty()
    Text(
        if (npub.isNotEmpty()) {
            "You are reading as ${shortNpub(npub)}. Reading needs no signer; posting does, because every reply, boost, like and zap is signed by your key."
        } else {
            "Reading needs no signer; posting does, because every reply, boost, like and zap is signed by your key."
        },
        style = MaterialTheme.typography.bodyMedium,
        color = Nal.colors.text2,
    )
    if (problem != null) {
        Spacer(Modifier.height(8.dp))
        ProblemText(problem)
    }
    Spacer(Modifier.height(16.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onNotNow) { Text("Not now") }
        Spacer(Modifier.size(8.dp))
        Button(onClick = onChoose) { Text("Choose a signer") }
    }
}

@Composable
private fun ProblemText(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = Nal.colors.danger,
        modifier = Modifier
            .fillMaxWidth()
            .background(Nal.colors.dangerBg, RoundedCornerShape(Nal.radiusSmall))
            .padding(12.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
    )
}

/** One status line shared by the panel's options (login-ui.ts setStatus). */
private class Status {
    var text by mutableStateOf("")
    var error by mutableStateOf(false)
    fun set(t: String, isError: Boolean = false) {
        text = t
        error = isError
    }
}

@Composable
private fun OrDivider() {
    Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = Nal.colors.line)
        Text("or", Modifier.padding(horizontal = 12.dp), color = Nal.colors.text3, style = MaterialTheme.typography.labelMedium)
        HorizontalDivider(Modifier.weight(1f), color = Nal.colors.line)
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nal.colors.text3, modifier = Modifier.padding(top = 6.dp))
}

@Composable
internal fun SignInPanelContent(manager: SignerManager, purpose: SignInPurpose, onResult: (SignInResult) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val signers = remember { runCatching { Nip55.signers(context) }.getOrDefault(emptyList()) }
    val status = remember { Status() }
    var busy by remember { mutableStateOf(false) }
    var showRemote by remember { mutableStateOf(signers.isEmpty()) }
    var done by remember { mutableStateOf(false) }
    val finish: (SignInResult) -> Unit = { r ->
        if (!done) {
            done = true
            onResult(r)
        }
    }

    Column(modifier.fillMaxWidth()) {
        Text(signInNotice(purpose), style = MaterialTheme.typography.bodyMedium, color = Nal.colors.text2)
        Spacer(Modifier.height(16.dp))

        // ── Option 1: a signer app on this phone (NIP-55) ───────────────────
        for (app in signers) {
            Button(
                onClick = {
                    scope.launch {
                        busy = true
                        status.set("Waiting for ${app.label}…")
                        try {
                            when (val reply = manager.nip55PublicKey(app.packageName, purpose)) {
                                is Nip55.Reply.PublicKey -> {
                                    val pkg = reply.signerPackage ?: app.packageName
                                    status.set("Connected as ${Nip19.npub(reply.pubkeyHex).take(20)}…")
                                    finish(SignInResult(reply.pubkeyHex, manager.nip55Signer(reply.pubkeyHex, pkg, app.label)))
                                }
                                Nip55.Reply.Rejected -> status.set("${app.label} declined the request.", true)
                                else -> status.set("${app.label} did not return a public key.", true)
                            }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            status.set("Could not open ${app.label}.", true)
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy && !done,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Sign in with ${app.label}") }
            Spacer(Modifier.height(4.dp))
        }
        if (signers.isNotEmpty()) {
            val names = signers.joinToString(" or ") { it.label }
            Hint(
                when (purpose) {
                    SignInPurpose.Actions -> "Uses $names on this phone. It asks you to approve what it signs, unless you let it remember."
                    SignInPurpose.HostedLogin -> "Reads your public key from $names on this phone, then asks it to sign one login event."
                    SignInPurpose.ByokIdentity -> "Reads your public key from $names on this phone."
                },
            )
            OrDivider()
        }

        // ── Option 2: remote signer over NIP-46 ─────────────────────────────
        if (showRemote) {
            RemoteSignerSection(manager, purpose, status, onConnected = finish, enabled = !done)
        } else {
            OutlinedButton(onClick = { showRemote = true }, modifier = Modifier.fillMaxWidth(), enabled = !done) {
                Text("Use a remote signer")
            }
            Hint("For a signer on another device: scan a code, or open a nostrconnect link.")
        }

        Spacer(Modifier.height(16.dp))
        BunkerSection(manager, purpose, status, onConnected = finish, enabled = !done && !busy)

        OrDivider()
        when (purpose) {
            SignInPurpose.Actions -> Hint("A pasted npub cannot sign anything, so it is not offered here.")
            SignInPurpose.HostedLogin -> Hint(
                "Pasting an npub is not available here. Hosted mode keeps your settings and subscription under your key, so the server needs a signature to know it is really you. To only look at a feed without signing anything, use bring-your-own-key mode.",
            )
            SignInPurpose.ByokIdentity -> NpubEntry(status, onPick = { finish(SignInResult(it, null)) }, enabled = !done)
        }

        if (status.text.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text(
                status.text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (status.error) Nal.colors.danger else Nal.colors.text2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun RemoteSignerSection(
    manager: SignerManager,
    purpose: SignInPurpose,
    status: Status,
    onConnected: (SignInResult) -> Unit,
    enabled: Boolean,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var authUrl by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val handshake = remember(attempt) {
        manager.handshake(purpose) { url -> scope.launch(Dispatchers.Main) { authUrl = url } }
    }
    DisposableEffect(handshake) { onDispose { handshake.cancel() } }
    LaunchedEffect(handshake) {
        failed = false
        authUrl = null
        status.set("Waiting for approval in your signer…")
        try {
            val (session, user) = handshake.await()
            status.set("Connected as ${Nip19.npub(user).take(20)}…")
            onConnected(manager.remoteResult(purpose, session, user))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            status.set(e.message ?: Nip46.CANCELLED, true)
            failed = true
        }
    }
    val qr = remember(handshake.uri) { runCatching { SignInUtil.qrBitmap(handshake.uri, 720).asImageBitmap() }.getOrNull() }
    val canOpen = remember(handshake.uri) { runCatching { SignInUtil.canOpen(context, handshake.uri) }.getOrDefault(false) }

    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (qr != null) {
            Box(Modifier.background(Color.White, RoundedCornerShape(Nal.radiusSmall)).padding(10.dp)) {
                Image(qr, contentDescription = null, modifier = Modifier.size(232.dp).semantics { contentDescription = "Sign-in QR code" })
            }
        }
        Text(
            when (purpose) {
                SignInPurpose.Actions -> "Scan with Amber, or open the link below if your signer is on this device. Approve the connection and the kinds of post it lists."
                SignInPurpose.HostedLogin -> "Scan with Amber, or open the link below if your signer is on this device. Approve the connection, the login signature, and the kinds of post it lists."
                SignInPurpose.ByokIdentity -> "Scan with Amber, or open the link below if your signer is on this device."
            },
            style = MaterialTheme.typography.bodySmall,
            color = Nal.colors.text3,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp),
        )
        Spacer(Modifier.height(10.dp))
        if (canOpen) {
            Button(onClick = { SignInUtil.openInSigner(context, handshake.uri) }, enabled = enabled && !failed, modifier = Modifier.fillMaxWidth()) {
                Text("Open in signer app")
            }
        }
        OutlinedButton(
            onClick = {
                if (copyToClipboard(context, handshake.uri)) {
                    copied = true
                    scope.launch {
                        delay(1500)
                        copied = false
                    }
                } else {
                    status.set("Could not copy — select the code manually", true)
                }
            },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (copied) "Copied" else "Copy connection string") }
        authUrl?.let { url ->
            Spacer(Modifier.height(6.dp))
            Hint("Your signer asks you to approve this connection on a web page first.")
            Button(
                onClick = { if (!openCustomTab(context, url)) status.set("Could not open the approval page.", true) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Nal.colors.hero, contentColor = Nal.colors.onHero),
            ) { Text("Open approval page") }
        }
        if (failed && enabled) {
            Spacer(Modifier.height(6.dp))
            Button(onClick = { attempt++ }, modifier = Modifier.fillMaxWidth()) { Text("New code") }
        }
    }
}

@Composable
private fun BunkerSection(manager: SignerManager, purpose: SignInPurpose, status: Status, onConnected: (SignInResult) -> Unit, enabled: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf("") }
    var connecting by remember { mutableStateOf(false) }
    var authUrl by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = value,
            onValueChange = { value = it },
            label = { Text("Or paste a bunker:// link") },
            placeholder = { Text("bunker://…") },
            singleLine = true,
            enabled = enabled && !connecting,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        OutlinedButton(
            onClick = {
                val pointer = Nip46.parseBunker(value)
                if (pointer == null) {
                    status.set("That is not a bunker:// link. It starts with bunker://, then the signer's key and at least one relay.", true)
                    return@OutlinedButton
                }
                connecting = true
                status.set("Waiting for approval in your signer…")
                scope.launch {
                    try {
                        val (session, user) = withContext(Dispatchers.IO) {
                            manager.bunker(pointer, purpose) { url -> scope.launch(Dispatchers.Main) { authUrl = url } }
                        }
                        status.set("Connected as ${Nip19.npub(user).take(20)}…")
                        onConnected(manager.remoteResult(purpose, session, user))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        status.set(e.message ?: Nip46.CANCELLED, true)
                    } finally {
                        connecting = false
                    }
                }
            },
            enabled = enabled && !connecting && value.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (connecting) "Connecting…" else "Connect") }
        authUrl?.let { url ->
            Hint("Your signer asks you to approve this connection on a web page first.")
            Button(onClick = { if (!openCustomTab(context, url)) status.set("Could not open the approval page.", true) }, modifier = Modifier.fillMaxWidth()) {
                Text("Open approval page")
            }
        }
    }
}

@Composable
private fun NpubEntry(status: Status, onPick: (String) -> Unit, enabled: Boolean) {
    var value by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = value,
            onValueChange = { value = it },
            label = { Text("Paste an npub") },
            placeholder = { Text("npub1… or hex pubkey") },
            singleLine = true,
            enabled = enabled,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        OutlinedButton(
            onClick = {
                val v = value.trim()
                if (v.isEmpty()) {
                    status.set("Enter an npub or hex pubkey", true)
                    return@OutlinedButton
                }
                val hex = Nip19.pubkeyOf(v)
                if (hex == null) {
                    status.set("Invalid pubkey or npub: $v", true)
                    return@OutlinedButton
                }
                onPick(hex)
            },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Use this npub") }
    }
}
