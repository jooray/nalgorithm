package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import java.util.Collections

class RankerTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.close()

    private fun ranker(scorer: ScorerKind = ScorerKind.Chat, batchSize: Int = 20, concurrency: Int = 1) =
        Ranker(RankerConfig(LlmConfig(server.base(), "k", "m"), batchSize = batchSize, concurrency = concurrency, scorer = scorer))

    @Test
    fun `invalid chunk configuration is refused instead of freezing`() {
        try { ranker(batchSize = -1); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("batch size")) }
        try { ranker(concurrency = 100); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("concurrency")) }
    }

    @Test
    fun `a note boosted many times is scored once and every copy gets the score`() = runBlocking {
        val prompts = Collections.synchronizedList(mutableListOf<String>())
        server.handle { req ->
            val user = req.json()["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonPrimitive.content
            prompts.add(user)
            chatResponse("""[[1, 8, "relays"], [2, 3, "meh"]]""")
        }
        val orig = EmbeddedPost("orig", "c".repeat(64), "relay news")
        val posts = listOf(
            fetchedPost("b1", PostType.Boost, author = "1".repeat(64), originalPost = orig, createdAt = 10),
            fetchedPost("b2", PostType.Boost, author = "2".repeat(64), originalPost = orig, createdAt = 20),
            fetchedPost("p", content = "gm", createdAt = 30),
        )
        val emitted = mutableListOf<String>()
        val progress = mutableListOf<Pair<Int, Int>>()
        val out = ranker().score(posts, ScoreOptions("relays", onBatchScored = { b -> emitted.addAll(b.map { it.id }) }, onProgress = { n, t -> progress.add(n to t) }))
        assertEquals(1, prompts.size)
        assertTrue(prompts[0].contains("Score all 2 posts."))
        assertEquals(listOf("b2", "b1", "p"), out.map { it.id })
        assertEquals(listOf(8.0, 8.0, 3.0), out.map { it.score })
        assertEquals(setOf("b1", "b2", "p"), emitted.toSet())
        assertEquals(listOf(2 to 2), progress)
    }

    @Test
    fun `posts the model skipped get the fallback score`() = runBlocking {
        server.handle { chatResponse("""[[1, 9, "yes"]]""") }
        val out = ranker().score(listOf(fetchedPost("a"), fetchedPost("b")), ScoreOptions("x"))
        assertEquals(9.0, out.first { it.id == "a" }.score, 0.0)
        val b = out.first { it.id == "b" }
        assertTrue(b.defaultScore)
        assertEquals(5.0, b.score, 0.0)
        assertEquals("b", out.last().id)
    }

    @Test
    fun `a 400 costs one batch its scores, a 401 stops the run`() = runBlocking {
        val posts = listOf(fetchedPost("a", author = "b".repeat(64)))
        server.handle { status(400) }
        val out = ranker(ScorerKind.Decision).score(posts, ScoreOptions("x"))
        assertTrue(out[0].defaultScore)
        server.handle { status(401) }
        try {
            ranker(ScorerKind.Decision).score(posts, ScoreOptions("x"))
            fail()
        } catch (e: Decision.ApiError) {
            assertTrue(e.message!!.contains("401"))
        }
        try {
            ranker(ScorerKind.Chat).score(posts, ScoreOptions("x"))
            fail()
        } catch (e: ProviderError) {
            assertEquals(401, e.status)
        }
    }

    @Test
    fun `decision scorer reads the score off the distribution`() = runBlocking {
        server.handle { req ->
            assertTrue(req.url.encodedPath.endsWith("/decisions"))
            val body = req.json()
            assertEquals(2, body["questions"]!!.jsonObject.size)
            status(
                200,
                """{"model":"jev","answers":{"p1":{"type":"score","score":4.2,"confidence":0.8,"probabilities":{"4":0.7,"5":0.25},"legend":{}},"p2":{"type":"score","score":"bad"}}}""",
            )
        }
        val debug = mutableListOf<DebugEntry>()
        val out = ranker(ScorerKind.Decision).score(listOf(fetchedPost("a", createdAt = 2), fetchedPost("b", createdAt = 1)), ScoreOptions("x", debug = debug))
        assertEquals(8.4, out[0].score, 0.0)
        assertTrue(out[0].justification!!.startsWith("70% clearly relevant"))
        assertTrue(out[1].defaultScore)
        assertEquals("Decision response answered 1/2 questions", debug.single().error)
    }

    @Test
    fun `batches run through a pool, each landing as it completes`() = runBlocking {
        server.handle { req ->
            val n = Regex("Score all (\\d+) posts").find(req.json()["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonPrimitive.content)!!.groupValues[1].toInt()
            chatResponse((1..n).joinToString(",", "[", "]") { "[$it, 6, \"ok\"]" })
        }
        val posts = (1..11).map { fetchedPost("p$it") }
        val batches = mutableListOf<Int>()
        val out = ranker(batchSize = 5, concurrency = 3).score(posts, ScoreOptions("x", onBatchScored = { batches.add(it.size) }))
        assertEquals(11, out.count { !it.defaultScore })
        assertEquals(listOf(1, 5, 5), batches.sorted())
    }
}
