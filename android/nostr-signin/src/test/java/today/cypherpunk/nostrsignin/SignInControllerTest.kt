package today.cypherpunk.nostrsignin

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class SignInControllerTest {
    private val pubkey = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"

    private class FakeBackend : SignInBackend {
        var exchanged: String? = null
        val polls = ArrayDeque<Any>()
        override suspend fun challenge() = Challenge("abc123", "example.com")
        override suspend fun exchangeSignedEvent(signedEventJson: String) { exchanged = signedEventJson }
        override suspend fun startNostrConnect() = ConnectSession("s1", "p1", "nostrconnect://x")
        override suspend fun startBunker(bunkerUri: String) = ConnectSession("s2", "p2", null)
        override suspend fun poll(session: ConnectSession): PollResult {
            val next = polls.removeFirst()
            if (next is Throwable) throw next
            return next as PollResult
        }
        override fun isTransient(error: Throwable) = error is IOException
    }

    private class FakeSigner(val key: Nip55.Reply, val sign: (UnsignedEvent) -> Nip55.Reply) : SignerGateway {
        var signedWith: String? = null
        override suspend fun getPublicKey(signerPackage: String) = key
        override suspend fun signEvent(signerPackage: String, event: UnsignedEvent): Nip55.Reply {
            signedWith = signerPackage
            return sign(event)
        }
    }

    private fun TestScope.controller(backend: SignInBackend, signer: SignerGateway) =
        SignInController(backend, signer, this, pollIntervalMillis = 10, now = { 1700000000 })

    @Test fun signerHappyPath() = runTest {
        val backend = FakeBackend()
        val signer = FakeSigner(Nip55.Reply.PublicKey(pubkey, "com.amber")) { Nip55.Reply.Signed(it.signedJson("ab".repeat(64))) }
        val c = controller(backend, signer)
        c.signInWithSigner("com.chosen")
        advanceUntilIdle()
        assertEquals(SignInState.SignedIn, c.state.value)
        assertEquals("com.amber", signer.signedWith)
        assertTrue(backend.exchanged!!.contains("\"challenge\",\"abc123\""))
    }

    @Test fun signerRejectsSignature() = runTest {
        val c = controller(FakeBackend(), FakeSigner(Nip55.Reply.PublicKey(pubkey, null)) { Nip55.Reply.Rejected })
        c.signInWithSigner("com.amber")
        advanceUntilIdle()
        assertEquals(SignInState.Failed(SignInMethod.Signer, SignInFailure.SignerRejected), c.state.value)
    }

    @Test fun nostrConnectPollsThroughTransientErrors() = runTest {
        val backend = FakeBackend().apply {
            polls.addAll(listOf(PollResult.Pending(), IOException("blip"), PollResult.Pending("https://auth"), PollResult.Authenticated))
        }
        var opened: String? = null
        val c = controller(backend, FakeSigner(Nip55.Reply.Empty) { Nip55.Reply.Empty })
        c.startNostrConnect { opened = it }
        advanceUntilIdle()
        assertEquals("nostrconnect://x", opened)
        assertEquals(SignInState.SignedIn, c.state.value)
    }

    @Test fun bunkerExpiresAndRejectsBadLinks() = runTest {
        val backend = FakeBackend().apply { polls.add(PollResult.Expired) }
        val c = controller(backend, FakeSigner(Nip55.Reply.Empty) { Nip55.Reply.Empty })
        c.startBunker("nostrconnect://wrong")
        assertEquals(SignInState.Failed(SignInMethod.Bunker, SignInFailure.InvalidBunkerLink), c.state.value)
        c.startBunker(" bunker://abc ")
        advanceUntilIdle()
        assertEquals(SignInState.Expired(SignInMethod.Bunker), c.state.value)
    }

    @Test fun serverErrorStopsPolling() = runTest {
        val boom = IllegalStateException("403")
        val backend = FakeBackend().apply { polls.add(boom) }
        val c = controller(backend, FakeSigner(Nip55.Reply.Empty) { Nip55.Reply.Empty })
        c.startNostrConnect { }
        advanceUntilIdle()
        assertEquals(SignInState.Failed(SignInMethod.NostrConnect, SignInFailure.Server, boom), c.state.value)
    }
}
