package today.cypherpunk.nalgorithm.engine

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost

internal fun chatResponse(content: String): MockResponse =
    MockResponse.Builder().code(200).body("""{"choices":[{"message":{"content":${Js.quote(content)}},"finish_reason":"stop"}]}""").build()

internal fun status(code: Int, body: String = "{}"): MockResponse = MockResponse.Builder().code(code).body(body).build()

internal fun MockWebServer.handle(handler: (RecordedRequest) -> MockResponse) {
    dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = handler(request)
    }
}

internal fun RecordedRequest.json(): JsonObject = Js.parse(body!!.utf8())!!.jsonObject

internal fun MockWebServer.base(): String = url("/v1").toString().trimEnd('/')

internal fun fetchedPost(
    id: String,
    type: PostType = PostType.Original,
    author: String = "a".repeat(64),
    content: String = "post $id",
    createdAt: Long = 1000,
    originalPost: EmbeddedPost? = null,
    quotedPost: EmbeddedPost? = null,
) = FetchedPost(id, type, author, content, createdAt, quotedPost, originalPost, NostrEvent(id, author, createdAt, if (type == PostType.Boost) 6 else 1))

internal fun scoredPost(
    id: String,
    score: Double,
    type: PostType = PostType.Original,
    author: String = "a".repeat(64),
    content: String = "post $id",
    createdAt: Long = 1000,
    justification: String? = null,
    defaultScore: Boolean = false,
    originalPost: EmbeddedPost? = null,
    kind: Int? = 1,
) = ScoredPost(
    id = id, type = type, author = author, content = content, createdAt = createdAt,
    originalPost = originalPost, score = score, justification = justification, defaultScore = defaultScore,
    rawEvent = kind?.let { NostrEvent(id, author, createdAt, it) },
)
