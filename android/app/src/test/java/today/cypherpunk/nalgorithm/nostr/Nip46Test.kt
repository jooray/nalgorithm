package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.util.concurrent.CopyOnWriteArrayList

class Nip46Test {
    private val relays = FakeRelays()
    private val pool = RelayPool(relays, idleMs = 200)
    private val signerRelays = listOf("wss://a.example", "wss://b.example")

    /**
     * A remote signer like new Amber: it answers from a per-connection routing
     * key that is NOT the user's key, which only get_public_key reveals.
     */
    private inner class FakeSigner(val user: ByteArray = Keys.generateSecret()) {
        val routing = Keys.generateSecret()
        val routingPub = Keys.publicHex(routing)
        val requests = CopyOnWriteArrayList<String>()
        @Volatile var authUrlFirst: String? = null
        @Volatile var refuseSigning = false

        fun listen() {
            for (url in signerRelays) relays.relay(url).onPublish = ::onEvent
        }

        private fun reply(to: String, body: String) {
            val conv = Nip44.conversationKey(routing, to)
            val e = Nip46.envelope(routing, to, Nip44.encrypt(body, conv))
            relays.relay(signerRelays[0]).broadcast(e.toWireJson())
        }

        /** The signer scanned the code: it answers the connect with the secret. */
        fun scan(uri: String) {
            val url = uri.replace("nostrconnect://", "https://x.example/").toHttpUrl()
            val client = url.pathSegments[0]
            reply(client, "{\"id\":\"c1\",\"result\":\"${url.queryParameter("secret")}\"}")
        }

        private fun onEvent(event: NostrEvent) {
            if (event.kind != Nip46.KIND || event.tag("p") != routingPub) return
            val conv = Nip44.conversationKey(routing, event.pubkey)
            val req = relayJson.parseToJsonElement(Nip44.decrypt(event.content, conv)) as JsonObject
            val id = req["id"]!!.jsonPrimitive.content
            val method = req["method"]!!.jsonPrimitive.content
            if (requests.contains(event.id)) return
            requests.add(event.id)
            val params = (req["params"] as JsonArray).map { it.jsonPrimitive.content }
            authUrlFirst?.let {
                authUrlFirst = null
                reply(event.pubkey, "{\"id\":\"$id\",\"result\":\"auth_url\",\"error\":\"$it\"}")
                Thread.sleep(100)
            }
            when (method) {
                "connect" -> reply(event.pubkey, "{\"id\":\"$id\",\"result\":\"ack\"}")
                "get_public_key" -> reply(event.pubkey, "{\"id\":\"$id\",\"result\":\"${Keys.publicHex(user)}\"}")
                "switch_relays" -> reply(event.pubkey, "{\"id\":\"$id\",\"result\":\"null\"}")
                "sign_event" -> {
                    if (refuseSigning) {
                        reply(event.pubkey, "{\"id\":\"$id\",\"error\":\"User rejected the request\"}")
                        return
                    }
                    val t = relayJson.parseToJsonElement(params[0]) as JsonObject
                    val tags = (t["tags"] as JsonArray).map { tag -> (tag as JsonArray).map { it.jsonPrimitive.content } }
                    val signed = signLocal(
                        UnsignedEvent(Keys.publicHex(user), t["created_at"]!!.jsonPrimitive.content.toLong(), t["kind"]!!.jsonPrimitive.content.toInt(), tags, t["content"]!!.jsonPrimitive.content),
                        user,
                    )
                    reply(event.pubkey, "{\"id\":\"$id\",\"result\":${jsonQuote(signed.toJsonString())}}")
                }
                else -> reply(event.pubkey, "{\"id\":\"$id\",\"error\":\"unsupported\"}")
            }
        }
    }

    @Test fun nostrConnectUriCarriesSecretPermsAndMetadata() {
        val uri = Nip46.nostrConnectUri("c".repeat(64), signerRelays, "s3cret", listOf("sign_event:27235", "sign_event:1"))
        assertTrue(uri.startsWith("nostrconnect://" + "c".repeat(64) + "?relay=wss%3A%2F%2Fa.example&relay=wss%3A%2F%2Fb.example&secret=s3cret"))
        assertTrue(uri.contains("&perms=sign_event%3A27235%2Csign_event%3A1"))
        assertTrue(uri.contains("&name=Nalgorithm&url=https%3A%2F%2Fnalgorithm.cypherpunk.today&image="))
        assertFalse(Nip46.nostrConnectUri("c".repeat(64), signerRelays, "s", emptyList()).contains("perms="))
    }

    @Test fun purposesAskForTheWebsKinds() {
        assertEquals(listOf(27235, 1, 6, 7, 16, 9734), Nip46.signKinds(SignInPurpose.HostedLogin))
        assertEquals(listOf(1, 6, 7, 16, 9734), Nip46.signKinds(SignInPurpose.Actions))
        assertEquals(emptyList<Int>(), Nip46.signKinds(SignInPurpose.ByokIdentity))
        assertEquals(
            "[{\"type\":\"sign_event\",\"kind\":1},{\"type\":\"sign_event\",\"kind\":6},{\"type\":\"sign_event\",\"kind\":7},{\"type\":\"sign_event\",\"kind\":16},{\"type\":\"sign_event\",\"kind\":9734}]",
            SignerManager.permissionsJson(SignInPurpose.Actions),
        )
        assertNull(SignerManager.permissionsJson(SignInPurpose.ByokIdentity))
    }

    @Test fun parsesBunkerLinks() {
        val pk = "d".repeat(64)
        val p = Nip46.parseBunker("bunker://$pk?relay=wss%3A%2F%2Frelay.example&relay=wss://two.example/&secret=abc")!!
        assertEquals(pk, p.pubkey)
        assertEquals(listOf("wss://relay.example", "wss://two.example"), p.relays)
        assertEquals("abc", p.secret)
        assertNull(Nip46.parseBunker("bunker://$pk"))
        assertNull(Nip46.parseBunker("bunker://nothex?relay=wss://r.example"))
        assertNull(Nip46.parseBunker("nostrconnect://$pk?relay=wss://r.example"))
        assertNull(Nip46.parseBunker("bunker://$pk?relay=https://r.example"))
    }

    @Test fun savedSignerRecords() {
        val a = "a".repeat(64)
        val b = "b".repeat(64)
        val c = "c".repeat(64)
        val good = "{\"v\":1,\"user\":\"$a\",\"client\":\"$b\",\"remote\":\"$c\",\"relays\":[\"wss://nos.lol\"]}"
        assertEquals(SavedRemoteSigner(1, a, b, c, listOf("wss://nos.lol")), SavedRemoteSigner.parse(good))
        assertNull(SavedRemoteSigner.parse(null))
        assertNull(SavedRemoteSigner.parse("not json"))
        assertNull(SavedRemoteSigner.parse(good.replace("\"v\":1", "\"v\":2")))
        assertNull(SavedRemoteSigner.parse(good.replace(b, "xyz")))
        assertNull(SavedRemoteSigner.parse(good.replace("\"user\":\"$a\"", "\"user\":\"${a.uppercase()}\"")))
        assertNull(SavedRemoteSigner.parse(good.replace("[\"wss://nos.lol\"]", "[\"https://x\",3]")))
        assertEquals(listOf("wss://a"), SavedRemoteSigner.parse(good.replace("[\"wss://nos.lol\"]", "[\"wss://a\",3]"))!!.relays)
        assertTrue(SavedRemoteSigner.keepAfterSignError("User rejected the request"))
        assertFalse(SavedRemoteSigner.keepAfterSignError("The signer did not answer the sign request in time."))
    }

    @Test fun handshakeUsesGetPublicKeyNotTheRoutingKey() = runBlocking {
        val signer = FakeSigner().also { it.listen() }
        val handshake = NostrConnectHandshake(pool, signerRelays, listOf("sign_event:1"))
        Thread {
            Thread.sleep(300)
            signer.scan(handshake.uri)
        }.start()
        val (session, user) = handshake.await(10_000)
        assertEquals(Keys.publicHex(signer.user), user)
        assertNotEquals(signer.routingPub, user)
        assertEquals(signer.routingPub, session.remotePubkey)

        // The same session signs, and the result is checked.
        val template = UnsignedEvent(user, 1_700_000_000, 7, listOf(listOf("e", "1".repeat(64))), "+")
        val signed = session.signEvent(template, 10_000)
        assertTrue(signed.verify())
        assertEquals(template.id, signed.id)

        // Saved and resumed without a new handshake (a later launch).
        val saved = session.saved(user)
        session.close()
        val resumed = RemoteSignerSession(pool, Hex.decode(saved.client), saved.remote, saved.relays)
        assertTrue(resumed.signEvent(template.copy(content = "again"), 10_000).verify())
        resumed.close()
    }

    @Test fun aWrongSecretIsNotAConnection() = runBlocking {
        val signer = FakeSigner().also { it.listen() }
        val handshake = NostrConnectHandshake(pool, signerRelays, emptyList())
        Thread {
            Thread.sleep(200)
            // An "ack" or another secret must not pass for the nostrconnect secret.
            signer.scan(handshake.uri.replace(Regex("secret=[0-9a-f]+"), "secret=ack"))
        }.start()
        try {
            handshake.await(1_500)
            fail("connected without the secret")
        } catch (e: SignerRpcException) {
            assertEquals(Nip46.CANCELLED, e.message)
        }
    }

    @Test fun cancelEndsTheWait() = runBlocking {
        val handshake = NostrConnectHandshake(pool, signerRelays, emptyList())
        Thread {
            Thread.sleep(200)
            handshake.cancel()
        }.start()
        val started = System.currentTimeMillis()
        try {
            handshake.await(30_000)
            fail("not cancelled")
        } catch (e: SignerRpcException) {
            assertTrue(System.currentTimeMillis() - started < 5_000)
        }
    }

    @Test fun bunkerConnectWithAuthUrlChallenge() = runBlocking {
        val signer = FakeSigner().also {
            it.listen()
            it.authUrlFirst = "https://signer.example/approve/123"
        }
        val urls = CopyOnWriteArrayList<String>()
        val pointer = Nip46.BunkerPointer(signer.routingPub, signerRelays, "sec")
        val (session, user) = connectBunker(pool, pointer, listOf("sign_event:1"), { urls.add(it) }, 10_000)
        assertEquals(Keys.publicHex(signer.user), user)
        assertEquals(listOf("https://signer.example/approve/123"), urls)
        session.close()
    }

    @Test fun aRefusalIsReportedAsDeclined() = runBlocking {
        val signer = FakeSigner().also {
            it.listen()
            it.refuseSigning = true
        }
        val pointer = Nip46.BunkerPointer(signer.routingPub, signerRelays, null)
        val (session, user) = connectBunker(pool, pointer, emptyList(), {}, 10_000)
        val remote = RemoteSigner(user, session)
        try {
            signChecked(remote, NoteLogic.likeTemplate(NoteLogic.Target("1".repeat(64), "2".repeat(64))))
            fail("signed")
        } catch (e: SignFailure) {
            assertEquals("Your signer declined the request.", e.message)
        }
        session.close()
    }

    @Test fun signCheckedRefusesAnotherKey() = runBlocking {
        val mine = LocalSigner(Keys.generateSecret())
        val impostor = object : NostrSigner {
            override val pubkey = mine.pubkey
            override val label = "x"
            override suspend fun sign(event: UnsignedEvent) = LocalSigner(TestEvents.bob).sign(event.copy(pubkey = Keys.publicHex(TestEvents.bob)))
        }
        try {
            signChecked(impostor, NoteLogic.likeTemplate(NoteLogic.Target("1".repeat(64), "2".repeat(64))))
            fail("accepted")
        } catch (e: SignFailure) {
            assertEquals("Your signer signed with a different key than the one you are signed in as.", e.message)
        }
        assertTrue(signChecked(mine, NoteLogic.likeTemplate(NoteLogic.Target("1".repeat(64), "2".repeat(64)))).verify())
    }

    @Test fun responsesAreMatchedById() {
        val r = Nip46.parseResponse("{\"id\":\"x-1\",\"result\":\"auth_url\",\"error\":\"https://a.example\"}")!!
        assertEquals("x-1", r.id)
        assertEquals("auth_url", r.result)
        assertNull(Nip46.parseResponse("{\"result\":\"ok\"}"))
        assertEquals("{\"id\":\"1\",\"method\":\"sign_event\",\"params\":[\"{}\"]}", Nip46.requestJson("1", "sign_event", listOf("{}")))
        assertEquals(
            "{\"kind\":1,\"content\":\"a\\\"b\",\"tags\":[[\"p\",\"x\"]],\"created_at\":5}",
            Nip46.templateJson(UnsignedEvent("f".repeat(64), 5, 1, listOf(listOf("p", "x")), "a\"b")),
        )
        assertTrue(JsonPrimitive("x").isString)
    }
}
