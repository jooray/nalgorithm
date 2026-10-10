package today.cypherpunk.nalgorithm.engine

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LlmTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.close()

    private fun config(key: String = "k", model: String = "m", timeoutMs: Long? = null) = LlmConfig(server.base(), key, model, timeoutMs = timeoutMs)

    @Test
    fun `bad credentials fail once and a keyless local model sends no Authorization`() = runBlocking {
        server.enqueue(status(401))
        try {
            chatCompletionWithRetry(config(key = ""), emptyList(), baseDelayMs = 0)
            fail("expected a 401")
        } catch (e: ProviderError) {
            assertEquals(401, e.status)
            assertEquals("Model request failed (401). Check your model API key and permissions.", e.message)
        }
        assertEquals(1, server.requestCount)
        assertNull(server.takeRequest().headers["Authorization"])
    }

    @Test
    fun `a 5xx is retried, honouring Retry-After, and the body is the OpenAI shape`() = runBlocking {
        server.enqueue(MockResponse.Builder().code(503).addHeader("retry-after", "0").build())
        server.enqueue(chatResponse("hello"))
        val out = chatCompletionWithRetry(config(), listOf(ChatMessage("user", "hi")), jsonMode = true, baseDelayMs = 1, temperature = 0.2)
        assertEquals("hello", out)
        assertEquals("Bearer k", server.takeRequest().headers["Authorization"])
        val body = server.takeRequest().json()
        assertEquals("m", body["model"]!!.jsonPrimitive.content)
        assertEquals("0.2", body["temperature"]!!.jsonPrimitive.content)
        assertTrue(body.containsKey("response_format"))
        assertFalse(body.containsKey("reasoning_effort"))
    }

    @Test
    fun `empty content is an error`() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("""{"choices":[{"message":{"content":""}}]}""").build())
        try {
            chatCompletion(config(), emptyList())
            fail()
        } catch (e: Exception) {
            assertEquals("LLM API returned empty response", e.message)
        }
    }

    @Test
    fun `a stalled call times out with the library's message`() = runBlocking {
        server.enqueue(chatResponse("late").newBuilder().headersDelay(2, TimeUnit.SECONDS).build())
        try {
            chatCompletion(config(timeoutMs = 300), emptyList())
            fail()
        } catch (e: Exception) {
            assertEquals("LLM API timed out after 300ms", e.message)
        }
    }

    @Test
    fun `streaming assembles deltas and skips malformed frames`() = runBlocking {
        val sse = buildString {
            append("data: {\"choices\":[{\"delta\":{\"content\":\"Good \"}}]}\n\n")
            append("data: not json\n\n")
            append(": keepalive\n\n")
            append("data: {\"choices\":[{\"delta\":{\"content\":\"morning\"}}]}\n\n")
            append("data: [DONE]\n\n")
        }
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(sse).build())
        val pieces = mutableListOf<String>()
        val out = chatCompletionStream(config(), listOf(ChatMessage("user", "x")), { pieces.add(it) })
        assertEquals("Good morning", out)
        assertEquals(listOf("Good ", "morning"), pieces)
        assertEquals(true, server.takeRequest().json()["stream"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `a stream that sends nothing says so`() = runBlocking {
        server.enqueue(MockResponse.Builder().code(200).body("data: [DONE]\n\n").build())
        try {
            chatCompletionStream(config(), emptyList(), {})
            fail()
        } catch (e: Exception) {
            assertEquals("LLM API returned empty response", e.message)
        }
        server.enqueue(MockResponse.Builder().code(200).body("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n").bodyDelay(2, TimeUnit.SECONDS).build())
        try {
            chatCompletionStream(config(timeoutMs = 300), emptyList(), {})
            fail()
        } catch (e: Exception) {
            assertEquals("LLM API sent nothing for 300ms", e.message)
        }
    }

    @Test
    fun `one provider budget bounds callers`() = runBlocking {
        val base = "https://budget.test"
        ProviderBudget.configure(base, "not-real", concurrency = 2, requestsPerMinute = 100_000.0)
        val active = AtomicInteger(0)
        var peak = 0
        (1..8).map {
            async {
                ProviderBudget.withSlot(base, "not-real") {
                    val now = active.incrementAndGet()
                    synchronized(this@LlmTest) { peak = maxOf(peak, now) }
                    delay(5)
                    active.decrementAndGet()
                }
            }
        }.awaitAll()
        assertEquals(2, peak)
    }

    @Test
    fun `a cancelled waiter leaves the queue, a full queue is ProviderBusy and not retried`() = runBlocking {
        val base = "https://budget-abort.test"
        ProviderBudget.configure(base, "not-real", concurrency = 1, requestsPerMinute = 100_000.0)
        val gate = CompletableDeferred<Unit>()
        val holder = launch { ProviderBudget.withSlot(base, "not-real") { gate.await() } }
        yield()
        var ran = false
        val waiter = launch { ProviderBudget.withSlot(base, "not-real") { ran = true } }
        yield()
        assertEquals(1, ProviderBudget.stats().queued)
        waiter.cancel()
        waiter.join()
        assertEquals(0, ProviderBudget.stats().queued)

        val waiting = (1..64).map { launch { ProviderBudget.withSlot(base, "not-real") { gate.await() } } }
        yield()
        try {
            ProviderBudget.withSlot(base, "not-real") {}
            fail()
        } catch (_: ProviderBusy) {
        }
        try {
            chatCompletionWithRetry(LlmConfig(base, "not-real", "m"), emptyList(), baseDelayMs = 0)
            fail()
        } catch (e: ProviderBusy) {
            assertEquals("The model queue is full. Try again shortly.", e.message)
        }
        gate.complete(Unit)
        holder.join()
        waiting.forEach { it.join() }
        assertFalse(ran)
    }
}
