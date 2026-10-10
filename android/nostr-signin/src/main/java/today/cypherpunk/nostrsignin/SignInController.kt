package today.cypherpunk.nostrsignin

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class SignInMethod { Signer, NostrConnect, Bunker }

enum class SignInFailure {
    /** The user cancelled or denied in the signer. */
    SignerRejected,
    /** The signer answered without a usable key or signature. */
    SignerEmpty,
    /** No signer app could handle the request. */
    SignerMissing,
    /** Not a bunker:// link. */
    InvalidBunkerLink,
    /** The server (or network) refused; see the cause. */
    Server,
}

sealed interface SignInState {
    data object Idle : SignInState

    /** Talking to the server or waiting for the signer. */
    data class Working(val method: SignInMethod) : SignInState

    /** NIP-46: waiting for the signer to answer through the relays. */
    data class Waiting(val method: SignInMethod, val uri: String?, val authUrl: String? = null) : SignInState

    data class Expired(val method: SignInMethod) : SignInState

    data class Failed(val method: SignInMethod, val failure: SignInFailure, val cause: Throwable? = null) : SignInState

    /** The backend stored the device token. */
    data object SignedIn : SignInState
}

/**
 * One sign-in attempt at a time, by any of the three methods. Owned by the
 * login screen's ViewModel with its scope. UI-agnostic: each app renders
 * [state] in its own design.
 */
class SignInController(
    private val backend: SignInBackend,
    private val signer: SignerGateway,
    private val scope: CoroutineScope,
    private val pollIntervalMillis: Long = 2_000,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val _state = MutableStateFlow<SignInState>(SignInState.Idle)
    val state: StateFlow<SignInState> = _state.asStateFlow()

    private var job: Job? = null

    /** NIP-55: public key, server challenge, signature, token. */
    fun signInWithSigner(signerPackage: String) = run(SignInMethod.Signer) {
        val key = signer.getPublicKey(signerPackage)
        if (key !is Nip55.Reply.PublicKey) return@run fail(SignInMethod.Signer, key.failure())
        // Some signers answer with their own package; it is the one to talk to.
        val pkg = key.signerPackage ?: signerPackage

        val challenge = backend.challenge()
        val event = UnsignedEvent.loginProof(key.pubkeyHex, challenge.challenge, challenge.domain, now())
        val signed = signer.signEvent(pkg, event)
        if (signed !is Nip55.Reply.Signed) return@run fail(SignInMethod.Signer, signed.failure())

        backend.exchangeSignedEvent(signed.eventJson)
        _state.value = SignInState.SignedIn
    }

    /**
     * NIP-46 nostrconnect://. [open] hands the URI to a signer on this phone
     * (return false when none can take it; the URI stays in the state for a QR).
     */
    fun startNostrConnect(open: (String) -> Unit) = run(SignInMethod.NostrConnect) {
        val session = backend.startNostrConnect()
        _state.value = SignInState.Waiting(SignInMethod.NostrConnect, session.uri)
        session.uri?.let(open)
        poll(SignInMethod.NostrConnect, session)
    }

    /** NIP-46 bunker://, where the signer is named by a pasted link. */
    fun startBunker(link: String) {
        val uri = link.trim()
        if (!uri.startsWith("bunker://")) {
            job?.cancel()
            _state.value = SignInState.Failed(SignInMethod.Bunker, SignInFailure.InvalidBunkerLink)
            return
        }
        run(SignInMethod.Bunker) {
            val session = backend.startBunker(uri)
            _state.value = SignInState.Waiting(SignInMethod.Bunker, null)
            poll(SignInMethod.Bunker, session)
        }
    }

    fun cancel() {
        job?.cancel()
        _state.value = SignInState.Idle
    }

    private suspend fun poll(method: SignInMethod, session: ConnectSession) {
        while (true) {
            delay(pollIntervalMillis)
            val result = try {
                backend.poll(session)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (backend.isTransient(e)) continue
                throw e
            }
            when (result) {
                PollResult.Authenticated -> { _state.value = SignInState.SignedIn; return }
                PollResult.Expired -> { _state.value = SignInState.Expired(method); return }
                is PollResult.Pending -> _state.value = SignInState.Waiting(method, session.uri, result.authUrl)
            }
        }
    }

    private fun run(method: SignInMethod, block: suspend () -> Unit) {
        job?.cancel()
        _state.value = SignInState.Working(method)
        job = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: android.content.ActivityNotFoundException) {
                _state.value = SignInState.Failed(method, SignInFailure.SignerMissing, e)
            } catch (e: Throwable) {
                _state.value = SignInState.Failed(method, SignInFailure.Server, e)
            }
        }
    }

    private fun fail(method: SignInMethod, failure: SignInFailure) {
        _state.value = SignInState.Failed(method, failure)
    }

    private fun Nip55.Reply.failure() = if (this is Nip55.Reply.Rejected) SignInFailure.SignerRejected else SignInFailure.SignerEmpty
}
