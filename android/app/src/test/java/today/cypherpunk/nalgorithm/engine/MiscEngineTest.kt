package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import today.cypherpunk.nalgorithm.model.MediaMeta
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** Media, relay URLs, the work pool, speech, the humanizer. */
class MiscEngineTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.close()

    @Test
    fun `imeta is bounded, http(s) only, deduplicated`() {
        val media = Media.readImeta(
            listOf(
                listOf("imeta", "url https://img.example/a.jpg", "dim 1200x800", "alt A cat on a keyboard", "m image/jpeg"),
                listOf("imeta", "url javascript:alert(1)", "dim 10x10"),
                listOf("imeta", "url https://img.example/a.jpg"),
                listOf("imeta", "url https://v.example/b.mp4", "dim 0x5", "m video/mp4"),
                listOf("p", "x"),
            ),
        )
        assertEquals(
            listOf(MediaMeta("https://img.example/a.jpg", 1200, 800, "A cat on a keyboard", "image/jpeg"), MediaMeta("https://v.example/b.mp4", mime = "video/mp4")),
            media,
        )
        assertEquals(emptyList<MediaMeta>(), Media.readImeta(null))
        assertEquals(8, Media.readImeta((0 until 20).map { listOf("imeta", "url https://x.example/$it.png") }).size)
    }

    @Test
    fun `relay urls from other people's events - public wss only`() {
        assertEquals("wss://relay.damus.io", RelayUrl.sanitize("wss://relay.damus.io/"))
        assertEquals("wss://relay.example/path", RelayUrl.sanitize(" wss://Relay.Example/path#frag "))
        for (bad in listOf("wss://10.0.0.1", "wss://[::1]", "ws://relay.damus.io", "wss://localhost", "wss://box.local", "wss://user:pw@relay.example", "wss://relay", "https://relay.example", "wss://192.168.1.1", "wss://[fe80::1]", "wss://[::ffff:7f00:1]", "nonsense", "wss://" + "a".repeat(200) + ".com")) {
            assertNull(bad, RelayUrl.sanitize(bad))
        }
        assertEquals("ws://127.0.0.1:7777", RelayUrl.sanitize("ws://127.0.0.1:7777", allowInsecure = true))
    }

    @Test
    fun `the worker pool never exceeds its limit and keeps order`() = runBlocking {
        val active = AtomicInteger(0)
        var peak = 0
        val out = mapConcurrent(listOf(1, 2, 3, 4, 5), 2) { n, _ ->
            peak = maxOf(peak, active.incrementAndGet())
            yield()
            delay(1)
            active.decrementAndGet()
            n * 2
        }
        assertEquals(2, peak)
        assertEquals(listOf(2, 4, 6, 8, 10), out)
        assertEquals(emptyList<Int>(), mapConcurrent(listOf(1, 2), 2, deadline = 0) { n, _ -> n })
    }

    @Test
    fun `speech splitting prefers paragraphs, then sentences, then words, then a hard cut`() {
        assertEquals(emptyList<String>(), Tts.splitText("   "))
        assertEquals(listOf("short"), Tts.splitText(" short ", 50))
        val chunks = Tts.splitText("First para here.\n\nSecond one is a bit longer. It has two sentences.", 30)
        assertTrue(chunks.all { it.length <= 30 })
        assertEquals("First para here.", chunks[0])
        assertEquals(listOf("aaaaa", "aaaaa", "aa"), Tts.splitText("a".repeat(12), 5))
        try { Tts.splitText("x", 0); fail() } catch (_: IllegalArgumentException) {}
        // Rejoining the pieces reproduces the text up to whitespace at the seams.
        val text = (1..30).joinToString(" ") { "Sentence $it ends here." }
        assertEquals(text.replace(" ", ""), Tts.splitText(text, 64).joinToString("").replace(" ", ""))
    }

    @Test
    fun `id3 tags are dropped from continuation chunks`() {
        val frame = byteArrayOf(0xFF.toByte(), 0xFB.toByte(), 1, 2)
        val v2 = byteArrayOf(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3) + byteArrayOf(9, 9, 9)
        assertEquals(frame.toList(), Tts.stripId3(v2 + frame).toList())
        val v1 = byteArrayOf(0x54, 0x41, 0x47) + ByteArray(125)
        assertEquals(frame.toList(), Tts.stripId3(frame + v1).toList())
        assertEquals(frame.toList(), Tts.stripId3(frame).toList())
    }

    @Test
    fun `chunks are synthesized concurrently but joined in text order, and one failure fails all`() = runBlocking {
        val active = AtomicInteger(0)
        var peak = 0
        server.handle { req ->
            val input = req.json()["input"]!!.jsonPrimitive.content
            peak = maxOf(peak, active.incrementAndGet())
            Thread.sleep(if (input.contains("number 0")) 150 else 20)
            active.decrementAndGet()
            if (input.contains("number 3") && input.contains("fail")) status(500)
            else MockResponse.Builder().code(200).body(Buffer().write("[$input]".toByteArray())).build()
        }
        val text = (0 until 6).joinToString(" ") { "Chunk number $it is spoken here." }
        val config = Tts.Config(server.base(), "k", "m", voice = "v", maxChars = 50)
        val audio = String(Tts.synthesize(config, text, baseDelayMs = 1, concurrency = 3))
        assertTrue("peak $peak", peak in 2..3)
        assertEquals("012345", Regex("number (\\d)").findAll(audio).joinToString("") { it.groupValues[1] })
        try {
            Tts.synthesize(config, text.replace("number 3 is", "number 3 fail is"), maxAttempts = 2, baseDelayMs = 1, concurrency = 3)
            fail()
        } catch (e: ProviderError) {
            assertEquals("Audio request failed (500). Check the TTS model, voice and key.", e.message)
        }
        try {
            Tts.synthesize(config.copy(format = "wav"), text)
            fail()
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("cannot be concatenated safely"))
        }
    }

    private val skillFile = File("../../lib/skills/humanizer/SKILL.md")

    @Test
    fun `the humanizer skill parses like sync-humanizer`() {
        val skill = HumanizerSkill.parse(skillFile.readText())
        assertTrue(Regex("^\\d+\\.\\d+\\.\\d+$").matches(skill.version))
        assertEquals(0.4, skill.temperature, 0.0)
        assertTrue(skill.prompt.startsWith("# Humanizer"))
        val parsed = HumanizerSkill.parse("---\nname: x\nversion: \"1.2.3\"\ntemperature: '0.7'\n---\n\nBody text\n")
        assertEquals("1.2.3", parsed.version)
        assertEquals(0.7, parsed.temperature, 0.0)
        assertEquals("Body text", parsed.prompt)
        try { HumanizerSkill.parse("no frontmatter"); fail() } catch (_: IllegalArgumentException) {}
        try { HumanizerSkill.parse("---\nname: x\n---\nbody"); fail() } catch (_: IllegalArgumentException) {}
    }

    @Test
    fun `the humanizer unwraps labels and fences, and keeps the original on a bad edit`() = runBlocking {
        assertEquals("Text here.", Humanizer.unwrap("Here is the revised text:\n\nText here."))
        assertEquals("Body", Humanizer.unwrap("```markdown\nBody\n```"))
        assertEquals("Note: keep this.\nMore.", Humanizer.unwrap("Note: keep this.\nMore."))
        val skill = HumanizerSkill("1", 0.4, "SKILL")
        val msgs = Humanizer.buildMessages(skill, "draft", forSpeech = true)
        assertEquals("SKILL", msgs[0].content)
        assertTrue(msgs[1].content.contains("read aloud by a speech engine"))
        assertTrue(msgs[1].content.endsWith("\n\ndraft"))

        val original = "word ".repeat(100).trim()
        server.handle { chatResponse("tiny") }
        val warnings = mutableListOf<String>()
        assertEquals(original, Humanizer.humanizeText(LlmConfig(server.base(), "k", "m"), skill, original, onWarning = { warnings.add(it) }))
        assertTrue(warnings.single().contains("likely truncated"))
        server.handle { chatResponse("rewritten ".repeat(80)) }
        assertEquals("rewritten ".repeat(80).trim(), Humanizer.humanizeText(LlmConfig(server.base(), "k", "m"), skill, original))
        assertEquals("0.4", server.takeRequest().let { it.json()["temperature"]!!.jsonPrimitive.content })
    }

    @Test
    fun `js compatibility helpers`() {
        assertEquals("\"a\\\"b\\\\c\\n\\u0001é🎉\"", Js.quote("a\"b\\c\n\u0001é🎉"))
        assertEquals("8", Js.number(8.0))
        assertEquals("6.67", Js.number(6.67))
        assertEquals(8L, Js.parseInt(" 8/10"))
        assertNull(Js.parseInt("x8"))
        assertEquals(-3L, Js.parseInt("-3.9"))
        assertEquals(3L, Js.round(2.5))
    }
}
