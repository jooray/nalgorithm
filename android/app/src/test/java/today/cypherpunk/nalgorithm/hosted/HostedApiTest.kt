package today.cypherpunk.nalgorithm.hosted

import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import today.cypherpunk.nalgorithm.model.FeedbackRule
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.nostr.NostrSigner
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.security.SecureRandom

class HostedApiTest {
    private lateinit var server: MockWebServer
    private lateinit var store: MapStore
    private lateinit var api: HostedApi

    class MapStore : SessionStore {
        val map = HashMap<String, String>()
        override fun get(key: String): String? = map[key]
        override fun set(key: String, value: String?) {
            if (value == null) map.remove(key) else map[key] = value
        }
    }

    /** Signs with a local key, as Amber or a remote signer would. */
    class LocalSigner(private val secret: ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }) : NostrSigner {
        override val pubkey: String = hex(Secp256k1.pubkeyCreate(secret).copyOfRange(1, 33))
        override val label = "Test"
        var signed: UnsignedEvent? = null
        override suspend fun sign(event: UnsignedEvent): NostrEvent {
            signed = event
            val sig = hex(Secp256k1.signSchnorr(unhex(event.id), secret, null))
            return NostrEvent(event.id, event.pubkey, event.createdAt, event.kind, event.tags, event.content, sig)
        }
    }

    companion object {
        fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
        fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        store = MapStore()
        api = HostedApi(OkHttpClient(), server.url("/app/api/").toString(), store)
    }

    @After fun tearDown() {
        server.close()
    }

    private fun respond(code: Int = 200, body: String = "{}", vararg headers: Pair<String, String>) {
        val b = MockResponse.Builder().code(code).body(body).addHeader("Content-Type", "application/json")
        for ((k, v) in headers) b.addHeader(k, v)
        server.enqueue(b.build())
    }

    private fun body(req: mockwebserver3.RecordedRequest) = Json.parseToJsonElement(req.body!!.utf8()).jsonObject

    @Test fun `login signs the challenge, stores the token and sends it as Bearer`() = runBlocking {
        val signer = LocalSigner()
        val loginUrl = server.url("/app/api/auth/login").toString()
        respond(body = """{"nonce":"abc123","expires_at":1791537352,"url":"$loginUrl"}""")
        respond(body = """{"npub":"${signer.pubkey}","token":"tok-1","expires_at":1}""")
        respond(body = """{"npub":"${signer.pubkey}","entitlement":{"state":"none"}}""")

        val npub = api.loginWithSigner(signer, signer.pubkey)
        assertEquals(signer.pubkey, npub)
        assertEquals("tok-1", api.token)
        assertEquals(signer.pubkey, api.lastNpub)

        val challenge = server.takeRequest()
        assertEquals("POST", challenge.method)
        assertEquals("/app/api/auth/challenge", challenge.target)
        assertTrue(challenge.headers["Content-Type"]!!.startsWith("application/json"))

        val login = server.takeRequest()
        assertEquals("/app/api/auth/login", login.target)
        val event = body(login)["event"]!!.jsonObject
        assertEquals(27235, event["kind"]!!.jsonPrimitive.content.toInt())
        assertEquals(
            listOf(listOf("u", loginUrl), listOf("method", "POST"), listOf("nonce", "abc123")),
            event["tags"]!!.jsonArray.map { t -> t.jsonArray.map { it.jsonPrimitive.content } },
        )
        assertEquals("", event["content"]!!.jsonPrimitive.content)
        val createdAt = event["created_at"]!!.jsonPrimitive.content.toLong()
        assertTrue(kotlin.math.abs(createdAt - System.currentTimeMillis() / 1000) < 60)
        assertEquals(128, event["sig"]!!.jsonPrimitive.content.length)

        val me = api.me()
        assertEquals("none", me.entitlement.state)
        assertEquals("Bearer tok-1", server.takeRequest().headers["Authorization"])
        assertEquals(mapOf("Authorization" to "Bearer tok-1"), api.authHeaders())
    }

    @Test fun `a signer that signs as another key is refused`() = runBlocking {
        val signer = LocalSigner()
        respond(body = """{"nonce":"n","url":"https://x/app/api/auth/login"}""")
        try {
            api.loginWithSigner(signer, "b".repeat(64))
            fail("expected a refusal")
        } catch (e: IllegalStateException) {
            assertEquals("The signer signed with a different key than the one you connected. Try again.", e.message)
        }
        assertNull(api.token)
        assertEquals(1, server.requestCount)
    }

    @Test fun `a bad signature is refused before it reaches the server`() = runBlocking {
        val real = LocalSigner()
        val forger = object : NostrSigner {
            override val pubkey = real.pubkey
            override val label = "Forger"
            override suspend fun sign(event: UnsignedEvent) = real.sign(event).copy(sig = "0".repeat(128))
        }
        respond(body = """{"nonce":"n","url":"https://x/app/api/auth/login"}""")
        try {
            api.loginWithSigner(forger, real.pubkey)
            fail("expected a refusal")
        } catch (e: IllegalStateException) {
            assertEquals("The signer returned an invalid login signature.", e.message)
        }
        assertEquals(1, server.requestCount)
    }

    @Test fun `errors carry status, code, message and the rest of the body`() = runBlocking {
        respond(409, """{"error":"a digest is already being made for you","code":"digest_running","startedAt":123}""")
        try {
            api.digestNow()
            fail()
        } catch (e: ApiError) {
            assertEquals(409, e.status)
            assertEquals("digest_running", e.code)
            assertEquals("a digest is already being made for you", e.message)
            assertEquals("123", e.data["startedAt"]!!.jsonPrimitive.content)
        }
        server.enqueue(MockResponse.Builder().code(502).body("<html>bad gateway</html>").build())
        try {
            api.settings()
            fail()
        } catch (e: ApiError) {
            assertEquals(502, e.status)
            assertNull(e.code)
            assertEquals("The server had a problem. Try again shortly.", describeError(e).message)
        }
    }

    @Test fun `a 401 ends the session on this device but keeps the remembered account`() = runBlocking {
        store.set("token", "old")
        api.lastNpub = "a".repeat(64)
        respond(401, """{"error":"not signed in"}""")
        try {
            api.me()
            fail()
        } catch (e: ApiError) {
            assertEquals(ErrorAction.Login, describeError(e).action)
        }
        assertNull(api.token)
        assertEquals(emptyMap<String, String>(), api.authHeaders())
        assertEquals("a".repeat(64), api.lastNpub)
    }

    @Test fun `logout forgets the session even when the server fails`() = runBlocking {
        store.set("token", "t")
        respond(500, """{"error":"internal error"}""")
        try {
            api.logout()
        } catch (_: ApiError) {
        }
        assertNull(api.token)
    }

    @Test fun `no network is status 0 with the network code`() = runBlocking {
        val dead = HostedApi(OkHttpClient(), "http://127.0.0.1:1/api/", store)
        try {
            dead.me()
            fail()
        } catch (e: ApiError) {
            assertEquals(0, e.status)
            assertEquals("network", e.code)
            assertEquals("Could not reach the server. Check your connection and try again.", describeError(e).message)
        }
    }

    @Test fun `writes always send a JSON content type and partial bodies`() = runBlocking {
        store.set("token", "t")
        respond(body = """{"userPrompt":"p","hoursBack":24,"topN":15,"learnFromLikes":true,"linkPreviews":false,"digestMinutes":6,"feedback":[{"kind":"more","excerpt":"x"},{"kind":"bad","excerpt":"y"}]}""")
        val saved = api.putFeedback(listOf(FeedbackRule("more", "x")))
        assertEquals(false, saved.linkPreviews)
        assertEquals(listOf(FeedbackRule("more", "x")), saved.feedback)
        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertTrue(req.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals(setOf("feedback"), body(req).keys)

        respond(body = "{}")
        api.resetLearned()
        val reset = server.takeRequest()
        assertEquals("POST", reset.method)
        assertEquals("{}", reset.body!!.utf8())
        assertTrue(reset.headers["Content-Type"]!!.startsWith("application/json"))
    }

    @Test fun `the schedule sends null voice and format explicitly`() = runBlocking {
        respond(body = """{"enabled":true,"time":"07:30","tz":"Europe/Bratislava","voice":null,"dmFormat":null,"nextRunAt":1790000000,"lastRunAt":null,"lastStatus":"sent"}""")
        val s = api.putSchedule(true, "07:30", "Europe/Bratislava", null, null, sendVoiceAndFormat = true)
        assertTrue(s.enabled)
        assertEquals(1_790_000_000L, s.nextRunAt)
        assertEquals("sent", s.lastStatus)
        val sent = body(server.takeRequest())
        assertEquals(JsonNull, sent["voice"])
        assertEquals(JsonNull, sent["dmFormat"])
        assertEquals("Europe/Bratislava", sent["tz"]!!.jsonPrimitive.content)

        respond(body = """{"enabled":true,"time":"07:30","tz":"UTC"}""")
        api.putSchedule(enabled = true, time = "07:30", tz = "UTC")
        assertEquals(setOf("enabled", "time", "tz"), body(server.takeRequest()).keys)
    }

    @Test fun `the feed is read with its profiles and odd posts are dropped`() = runBlocking {
        val pk = "c".repeat(64)
        respond(body = """{"entitlement":{"state":"trial","until":5},"fetched":240,"hoursBack":24,"createdAt":1700,"cached":false,"settingsChanged":false,
            "posts":[{"id":"p1","type":"boost","author":"$pk","content":"","createdAt":1,"originalPost":{"id":"o1","author":"$pk","content":"hi"},"score":7.5,"justification":"why","isNew":true,"media":[{"url":"https://m/x.jpg","width":10}]},
                     {"id":"p2","type":"original"}],
            "profiles":{"$pk":{"name":"Carol","picture":"https://p/c.jpg","nip05":5},"nothex":{"name":"x"}}}""")
        val feed = api.feed(100, force = true)
        val req = server.takeRequest()
        assertEquals("/app/api/feed?limit=100&force=1", req.target)
        assertEquals(Entitlement("trial", 5), feed.entitlement)
        assertEquals(1, feed.posts.size)
        assertEquals(PostType.Boost, feed.posts[0].type)
        assertEquals("o1", feed.posts[0].originalPost?.id)
        assertEquals(10, feed.posts[0].media!![0].width)
        assertEquals(setOf(pk), feed.profiles.keys)
        assertEquals("Carol", feed.profiles[pk]!!.name)
        assertNull(feed.profiles[pk]!!.nip05)
        assertEquals(1700L, feed.createdAt)
    }

    @Test fun `latest feed - none, unchanged and a snapshot`() = runBlocking {
        respond(body = """{"snapshot":null,"entitlement":{"state":"none"}}""")
        assertNull(api.latestFeed(null))
        assertEquals("/app/api/feed/latest", server.takeRequest().target)

        respond(body = """{"snapshot":null,"unchanged":true,"createdAt":5,"settingsChanged":true,"entitlement":{"state":"active"}}""")
        val unchanged = api.latestFeed(5) as LatestFeed.Unchanged
        assertTrue(unchanged.settingsChanged)
        assertEquals("/app/api/feed/latest?since=5", server.takeRequest().target)

        respond(body = """{"snapshot":{"fetched":3,"hoursBack":48,"posts":[],"profiles":{},"createdAt":9,"cached":true},"entitlement":{"state":"active","until":99}}""")
        val snap = api.latestFeed(1) as LatestFeed.Snapshot
        assertEquals(48, snap.feed.hoursBack)
        assertEquals(Entitlement("active", 99), snap.feed.entitlement)
    }

    @Test fun `the digest list uses its ETag and a 304 means unchanged`() = runBlocking {
        respond(200, """{"digests":[{"id":3,"createdAt":30,"text":"t","audioUrl":"https://a/3.mp3","durationSeconds":120.5},{"bad":true}]}""", "ETag" to "\"e1\"")
        val first = api.digests(30, summary = true) as DigestList.Fresh
        assertEquals("\"e1\"", first.etag)
        assertEquals(listOf("3"), first.digests.map { it.id })
        assertEquals("/app/api/digests?limit=30&summary=1", server.takeRequest().target)

        server.enqueue(MockResponse.Builder().code(304).addHeader("ETag", "\"e1\"").build())
        val second = api.digests(30, summary = true, etag = first.etag)
        assertTrue(second is DigestList.Unchanged)
        assertEquals("\"e1\"", server.takeRequest().headers["If-None-Match"])
    }

    @Test fun `one digest, also when wrapped`() = runBlocking {
        respond(body = """{"digest":{"id":4,"createdAt":40,"text":"x","audioUrl":null,"notes":[]}}""")
        val d = api.digest("4")!!
        assertEquals("4", d.id)
        assertEquals(emptyList<Any>(), d.notes)
        respond(body = """{"id":5,"createdAt":50,"text":"y","audioUrl":null}""")
        assertEquals("5", api.digest("5")!!.id)
    }

    @Test fun `digest now and status read the job`() = runBlocking {
        respond(202, """{"message":"$DIGEST_ON_ITS_WAY","running":true,"startedAt":77,"lastDurationSeconds":null,"lastStatus":null,"finishedAt":null}""")
        val (message, status) = api.digestNow()
        assertEquals(DIGEST_ON_ITS_WAY, message)
        assertTrue(status.running)
        assertEquals(77L, status.startedAt)
        respond(body = """{"state":"ranking","scored":4,"total":10,"startedAt":3}""")
        assertEquals(FeedProgress.Ranking(4, 10, 3), api.feedProgress())
    }

    @Test fun `checkout sends sats only for a custom amount, and asks to return to the app`() = runBlocking {
        respond(body = """{"invoice_id":"i1","checkout_url":"https://pay.example/i1","sats":10000}""")
        val charge = api.checkout(Plan.Nalgorithm, null)
        assertEquals("https://pay.example/i1", charge.checkoutUrl)
        val first = body(server.takeRequest())
        assertEquals(setOf("plan", "return"), first.keys)
        assertEquals("app", first["return"]!!.jsonPrimitive.content)
        respond(body = """{"invoice_id":"i2","checkout_url":"https://pay.example/i2"}""")
        api.checkout(Plan.AllAccess, 5000)
        val sent = body(server.takeRequest())
        assertEquals("all-access", sent["plan"]!!.jsonPrimitive.content)
        assertEquals("5000", sent["sats"]!!.jsonPrimitive.content)
    }

    @Test fun `previews encode the URL and vet the answer`() = runBlocking {
        respond(body = """{"title":"T","description":"D","siteName":"S","image":"preview/image?u=abc&s=def"}""")
        val card = api.preview("https://a.example/p?q=1&r=2")!!
        assertEquals("T", card.title)
        assertEquals(server.url("/app/api/preview/image?u=abc&s=def").toString(), api.previewImageUrl(card.image))
        assertEquals("/app/api/preview?url=https%3A%2F%2Fa.example%2Fp%3Fq%3D1%26r%3D2", server.takeRequest().target)
    }

    @Test fun `account export is pretty JSON and delete confirms and ends the session`() = runBlocking {
        store.set("token", "t")
        respond(body = """{"npub":"x","digests":[]}""")
        val text = api.exportAccount()
        assertTrue(text.contains("\n"))
        assertTrue(Json.parseToJsonElement(text).jsonObject["digests"] is JsonArray)
        server.takeRequest()
        respond(body = """{"ok":true}""")
        api.deleteAccount()
        assertEquals("delete", body(server.takeRequest())["confirm"]!!.jsonPrimitive.content)
        assertNull(api.token)
    }

    @Test fun `verifyEvent checks the id and the signature`() = runBlocking {
        val signer = LocalSigner()
        val event = signer.sign(buildLoginTemplate(signer.pubkey, "https://x/login", "n", 1))
        assertTrue(HostedApi.verifyEvent(event))
        assertFalse(HostedApi.verifyEvent(event.copy(content = "changed")))
        assertFalse(HostedApi.verifyEvent(event.copy(id = "0".repeat(64))))
        assertFalse(HostedApi.verifyEvent(event.copy(sig = "zz")))
    }

    @Test fun `URLs for audio and samples`() {
        assertEquals(server.url("/app/api/voices/af_sky/sample").toString(), api.voiceSampleUrl("af_sky"))
        assertEquals(server.url("/app/api/digests/12/audio").toString(), api.digestAudioUrl("12"))
        assertTrue(JsonObject(emptyMap()).isEmpty())
    }
}
