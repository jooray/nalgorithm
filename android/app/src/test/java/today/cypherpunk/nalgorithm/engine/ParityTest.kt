package today.cypherpunk.nalgorithm.engine

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import java.time.ZoneOffset

/**
 * Byte-for-byte agreement with the TypeScript library. The fixtures were produced by
 * lib/dist (TZ=UTC) from the same inputs, so a drift in a prompt, a key or the
 * splitter shows up here.
 */
class ParityTest {
    private val fixtures: JsonObject by lazy {
        val text = javaClass.getResourceAsStream("fixtures.json")!!.readBytes().toString(Charsets.UTF_8)
        Js.parse(text)!!.jsonObject
    }

    private fun str(key: String) = fixtures[key]!!.jsonPrimitive.content

    @Test
    fun `ranking context and score keys match the web app`() {
        assertEquals(
            str("ctx1"),
            RankingContext.rankingContext("  Bitcoin \"and\" privacy\n\ttools ✓ 🎉 ", "deepseek-v4-flash-0731", "chat", "https://api.venice.ai/api/v1/", true),
        )
        assertEquals(str("ctx2"), RankingContext.rankingContext("Cooking", "m", "decision", "http://localhost:11434/v1", false))
        assertEquals(str("key1"), RankingContext.contextualScoreKey("a".repeat(64), str("ctx1")))
        assertEquals(
            str("fp"),
            RankingContext.fingerprint(JsonArray(listOf(JsonPrimitive("x\u0001\u001f\\"), JsonPrimitive(1), JsonPrimitive(true)))),
        )
    }

    private val a = "a".repeat(64)
    private val b = "b".repeat(64)
    private val d = "d".repeat(64)
    private val posts = listOf(
        scoredPost(a, 8.0, author = b, content = "Hello world", createdAt = 1700000000, justification = "about bitcoin"),
        scoredPost(
            "c".repeat(64), 6.67, type = PostType.Boost, author = d, content = "", createdAt = 1700003600,
            originalPost = EmbeddedPost("e".repeat(64), "f".repeat(64), "Boosted text"),
        ),
        scoredPost("1".repeat(64), 9.0, type = PostType.Quote, author = b, content = "my take", createdAt = 1700007200)
            .copy(quotedPost = EmbeddedPost("2".repeat(64), d, "quoted")),
    )
    private val profiles = mapOf(b to ProfileData(b, name = "Alice"))

    @Test
    fun `digest messages are the library's, word for word`() {
        val messages = DigestWriter.buildDigestMessages(
            DigestWriter.Options(
                posts = posts, profiles = profiles, userPrompt = "Bitcoin", learnedPrompt = "likes relays",
                topN = 15, targetMinutes = 3, forSpeech = true, zone = ZoneOffset.UTC,
            ),
        )
        val expected = fixtures["digest"]!!.jsonArray
        assertEquals(expected.size, messages.size)
        for (i in messages.indices) {
            assertEquals(expected[i].jsonObject["role"]!!.jsonPrimitive.content, messages[i].role)
            assertEquals(expected[i].jsonObject["content"]!!.jsonPrimitive.content, messages[i].content)
        }
    }

    @Test
    fun `decision request matches`() {
        val req = Scoring.buildDecisionRequest(listOf(posts[2].fetched()), "Bitcoin", "learned", DecisionShape.ProfileInQuestion, profiles)
        val expected = fixtures["decision"]!!.jsonObject
        assertEquals(expected["state"]!!.jsonPrimitive.content, req.state)
        val q = expected["questions"]!!.jsonObject["p1"]!!.jsonObject
        assertEquals(q["instructions"]!!.jsonPrimitive.content, req.questions.getValue("p1").instructions)
        assertEquals(q["criteria"]!!.jsonArray.map { it.jsonPrimitive.content }, req.questions.getValue("p1").criteria)
    }

    @Test
    fun `speech splitting matches`() {
        val expected = fixtures["split"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(expected, Tts.splitText(str("splitInput"), 120))
    }
}
