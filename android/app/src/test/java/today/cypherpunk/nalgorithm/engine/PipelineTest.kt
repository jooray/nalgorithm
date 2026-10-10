package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import java.util.Collections

/** lib/test/pipeline.test.mjs and ranking-context.test.mjs. */
class PipelineTest {
    private lateinit var server: MockWebServer
    private val seenModels = Collections.synchronizedList(mutableListOf<String>())

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.close()

    private class MemoryStore(scores: Map<String, CachedScore> = emptyMap(), var learned: LearnedState? = null) : PipelineStore {
        val scores = HashMap(scores)
        var flushed = 0
        override suspend fun getLearned() = learned
        override suspend fun putLearned(state: LearnedState) { learned = state }
        override suspend fun getScores(keys: List<String>) = keys.mapNotNull { k -> scores[k]?.let { k to it } }.toMap()
        override suspend fun putScores(entries: Map<String, CachedScore>) { scores.putAll(entries) }
        override suspend fun flush() { flushed++ }
    }

    private fun fakeRanker(calls: MutableList<List<String>>, scoreFor: (FetchedPost) -> Pair<Double, Boolean>) = PostScorer { posts, opts ->
        calls.add(posts.map { it.id })
        val scored = posts.map { p -> scoreFor(p).let { (s, d) -> p.scored(s, null, d) } }
        opts.onBatchScored?.invoke(scored)
        opts.onProgress?.invoke(scored.size, posts.size)
        scored
    }

    private fun llm(model: String = "m") = LlmConfig(server.base(), "k", model)

    private fun chat(handler: (String) -> String?) = server.handle { req ->
        val model = req.json()["model"]!!.jsonPrimitive.content
        seenModels.add(model)
        handler(model)?.let { chatResponse(it) } ?: status(500)
    }

    @Test
    fun `scorePostsCached scores only uncached posts and keeps input order`() = runBlocking {
        val store = MemoryStore(mapOf("b" to CachedScore(8.0, createdAt = 1000)))
        val calls = mutableListOf<List<String>>()
        val out = Pipeline.scorePostsCached(fakeRanker(calls) { 3.0 to false }, store, ScorerKind.Chat, listOf(fetchedPost("a"), fetchedPost("b"), fetchedPost("c")), Pipeline.ScoreCachedInput(userPrompt = "x"))
        assertEquals(listOf(listOf("a", "c")), calls)
        assertEquals(listOf("a" to 3.0, "b" to 8.0, "c" to 3.0), out.map { it.id to it.score })
        assertEquals(3.0, store.scores.getValue("a").score, 0.0)
        assertEquals(1, store.flushed)
    }

    @Test
    fun `scores from the other scorer are ignored, decision scores are tagged, fallbacks never cached`() = runBlocking {
        val calls = mutableListOf<List<String>>()
        Pipeline.scorePostsCached(fakeRanker(calls) { 2.0 to false }, MemoryStore(mapOf("a" to CachedScore(9.0, scorer = "decision"))), ScorerKind.Chat, listOf(fetchedPost("a")), Pipeline.ScoreCachedInput(userPrompt = "x"))
        assertEquals(listOf(listOf("a")), calls)

        val store = MemoryStore()
        val out = Pipeline.scorePostsCached(fakeRanker(mutableListOf()) { if (it.id == "bad") 5.0 to true else 6.0 to false }, store, ScorerKind.Decision, listOf(fetchedPost("good"), fetchedPost("bad")), Pipeline.ScoreCachedInput(userPrompt = "x"))
        assertEquals("decision", store.scores.getValue("good").scorer)
        assertFalse(store.scores.containsKey("bad"))
        assertTrue(out.first { it.id == "bad" }.defaultScore)
    }

    @Test
    fun `a boost reuses its target's score`() = runBlocking {
        val boost = fetchedPost("boost1", PostType.Boost, originalPost = EmbeddedPost("orig", "x", "y"))
        val calls = mutableListOf<List<String>>()
        val out = Pipeline.scorePostsCached(fakeRanker(calls) { 1.0 to false }, MemoryStore(mapOf("orig" to CachedScore(7.0, "j", 1000))), ScorerKind.Chat, listOf(boost), Pipeline.ScoreCachedInput(userPrompt = "x"))
        assertTrue(calls.isEmpty())
        assertEquals(7.0, out[0].score, 0.0)
        assertEquals("j", out[0].justification)
    }

    @Test
    fun `a context change scores again, an unchanged one is free`() = runBlocking {
        val store = MemoryStore()
        var calls = 0
        val ranker = PostScorer { posts, opts ->
            calls++
            val out = posts.map { it.scored(calls.toDouble()) }
            opts.onBatchScored?.invoke(out)
            out
        }
        for (context in listOf("a", "a", "b")) {
            Pipeline.scorePostsCached(ranker, store, ScorerKind.Chat, listOf(fetchedPost("a".repeat(64))), Pipeline.ScoreCachedInput(context = context, userPrompt = "x"))
        }
        assertEquals(2, calls)
        assertEquals(64, RankingContext.contextualScoreKey("a".repeat(64), RankingContext.rankingContext("Bitcoin", "m", "chat")).length)
        val base = RankingContext.rankingContext("Bitcoin", "m", "chat")
        for (other in listOf(
            RankingContext.rankingContext("Cooking", "m", "chat"),
            RankingContext.rankingContext("Bitcoin", "other", "chat"),
            RankingContext.rankingContext("Bitcoin", "m", "chat", learnFromLikes = false),
        )) assertTrue(base != other)
    }

    @Test
    fun `waits for a turn only when something needs scoring, and always gives it back`() = runBlocking {
        val events = mutableListOf<String>()
        val before: suspend (Int) -> (() -> Unit)? = { n -> events.add("enter $n"); { events.add("leave") } }
        Pipeline.scorePostsCached(fakeRanker(mutableListOf()) { 3.0 to false }, MemoryStore(mapOf("a" to CachedScore(8.0))), ScorerKind.Chat, listOf(fetchedPost("a")), Pipeline.ScoreCachedInput(userPrompt = "x", beforeScoring = before))
        assertTrue(events.isEmpty())
        Pipeline.scorePostsCached(fakeRanker(mutableListOf()) { 3.0 to false }, MemoryStore(), ScorerKind.Chat, listOf(fetchedPost("a"), fetchedPost("b")), Pipeline.ScoreCachedInput(userPrompt = "x", beforeScoring = before))
        assertEquals(listOf("enter 2", "leave"), events)
        try {
            Pipeline.scorePostsCached(PostScorer { _, _ -> throw Exception("provider down") }, MemoryStore(), ScorerKind.Chat, listOf(fetchedPost("c")), Pipeline.ScoreCachedInput(userPrompt = "x", beforeScoring = before))
            fail()
        } catch (e: Exception) {
            assertEquals("provider down", e.message)
        }
        assertEquals(listOf("enter 1", "leave"), events.drop(2))
    }

    @Test
    fun `batches already paid for survive a run that fails later`() = runBlocking {
        val store = MemoryStore()
        val ranker = PostScorer { posts, opts ->
            opts.onBatchScored?.invoke(listOf(posts[0].scored(7.0)))
            throw Exception("second batch failed")
        }
        try {
            Pipeline.scorePostsCached(ranker, store, ScorerKind.Chat, listOf(fetchedPost("a"), fetchedPost("b")), Pipeline.ScoreCachedInput(userPrompt = "x"))
            fail()
        } catch (_: Exception) {
        }
        assertEquals(7.0, store.scores.getValue("a").score, 0.0)
    }

    @Test
    fun `the digest system prompt carries the humanizer rules exactly once`() {
        val sys = DigestWriter.buildDigestMessages(DigestWriter.Options(posts = listOf(scoredPost("a", 5.0)), userPrompt = "x"))[0].content
        assertEquals(1, sys.split(DigestWriter.HUMANIZER_APPENDIX).size - 1)
    }

    @Test
    fun `writeDigest falls back to the second model, and rethrows without one`() = runBlocking {
        chat { model -> if (model == "primary") null else "fallback digest" }
        val digest = DigestWriter.Options(posts = listOf(scoredPost("a", 5.0)), userPrompt = "x")
        val out = Pipeline.writeDigest(Pipeline.DigestModel(llm("primary")), digest, fallback = Pipeline.DigestModel(llm("fallback")), retryBaseDelayMs = 1)
        assertEquals("fallback digest", out)
        assertEquals("fallback", seenModels.last())
        try {
            Pipeline.writeDigest(Pipeline.DigestModel(llm("primary")), digest, retryBaseDelayMs = 1)
            fail()
        } catch (e: ProviderError) {
            assertEquals(500, e.status)
        }
    }

    private class FakeLikes(val page: LikesPage) : LikesSource {
        val asked = mutableListOf<Triple<Int, Long?, Long?>>()
        override suspend fun getLikes(pubkeyHex: String, limit: Int, since: Long?, until: Long?): LikesPage {
            asked.add(Triple(limit, since, until))
            return page
        }
    }

    @Test
    fun `learning keeps the stored prompt when there are no new likes`() = runBlocking {
        val store = MemoryStore(learned = LearnedState("old", "t", lastLikeTimestamp = 100))
        val likes = FakeLikes(LikesPage(emptyList()))
        val out = Pipeline.refreshLearnedPrompt(likes, store, llm(), "p", now = { 1_000_000 })
        assertEquals("old", out)
        // The overlap catches delayed reactions; processed ids prevent learning twice.
        assertEquals(0L, likes.asked[0].second)
    }

    @Test
    fun `learning evolves the prompt and advances the high-water mark`() = runBlocking {
        chat { "new summary" }
        val store = MemoryStore(learned = LearnedState("old", "t", lastLikeTimestamp = 100))
        val out = Pipeline.refreshLearnedPrompt(FakeLikes(LikesPage(listOf(LikedPostContent("x", "liked", "a")))), store, llm(), "p", pauseMs = 0, now = { 5_000_000 })
        assertEquals("new summary", out)
        assertEquals("new summary", store.learned!!.prompt)
        assertEquals(5000L, store.learned!!.lastLikeTimestamp)
    }

    @Test
    fun `learning survives an LLM failure and keeps the old prompt`() = runBlocking {
        chat { null }
        val store = MemoryStore(learned = LearnedState("old", "t", lastLikeTimestamp = 100))
        val out = Pipeline.refreshLearnedPrompt(FakeLikes(LikesPage(listOf(LikedPostContent("x", "liked", "a")))), store, llm(), "p", pauseMs = 0, retryBaseDelayMs = 1)
        assertEquals("old", out)
        assertEquals(100L, store.learned!!.lastLikeTimestamp)
    }

    @Test
    fun `learning deduplicates reaction ids and advances to reaction time`() = runBlocking {
        chat { "new taste" }
        val store = MemoryStore(learned = LearnedState("old", "t", lastLikeTimestamp = 100, processedReactionIds = listOf("old")))
        val likes = FakeLikes(LikesPage(listOf(LikedPostContent("a", "old", "x", "old", 110), LikedPostContent("b", "new", "x", "new", 120))))
        Pipeline.refreshLearnedPrompt(likes, store, llm(), "p", pauseMs = 0, now = { 5_000_000 })
        assertEquals(120L, store.learned!!.lastLikeTimestamp)
        assertTrue("new" in store.learned!!.processedReactionIds!!)
        Pipeline.refreshLearnedPrompt(likes, store, llm(), "p", pauseMs = 0)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `the first run reads only the newest page and sets the watermark there`() = runBlocking {
        chat { "first taste" }
        val store = MemoryStore()
        val page = LikesPage((0 until 200).map { LikedPostContent("e$it", "like $it", "x", "r$it", 4000L + it) }, reactionCount = 200, nextUntil = 3999)
        val likes = FakeLikes(page)
        Pipeline.refreshLearnedPrompt(likes, store, llm(), "p", pauseMs = 0, batchSize = 200, now = { 5_000_000 })
        assertEquals(Triple(200, null, null), likes.asked[0])
        assertNull(store.learned!!.backfillUntil)
        assertEquals(4199L, store.learned!!.lastLikeTimestamp)
    }

    @Test
    fun `catch-up after a long absence reaches back at most the age cap`() = runBlocking {
        val store = MemoryStore(learned = LearnedState("old", "t", lastLikeTimestamp = 100, backfillUntil = 200))
        val likes = FakeLikes(LikesPage(emptyList()))
        val nowSec = 400L * 86_400
        Pipeline.refreshLearnedPrompt(likes, store, llm(), "p", now = { nowSec * 1000 })
        assertEquals(nowSec - Pipeline.LEARN_MAX_AGE_SECONDS, likes.asked[0].second)
        assertNull(likes.asked[0].third)
    }

    @Test
    fun `the learner summarizes at most 100 likes and returns empty on failure`() = runBlocking {
        chat { "  taste  " }
        val learner = Learner(llm())
        assertEquals("", learner.summarizeLikes(emptyList()))
        assertEquals("taste", learner.summarizeLikes((1..150).map { LikedPostContent("$it", "post nostr:npub1xyz $it", "a") }))
        val prompt = Learner.buildSummarizationPrompt(listOf(LikedPostContent("1", "hi nostr:note1abc\nthere", "a")))
        assertTrue(prompt.contains("1. \"hi  there\""))
    }
}
