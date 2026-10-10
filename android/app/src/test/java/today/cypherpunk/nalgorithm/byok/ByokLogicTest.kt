package today.cypherpunk.nalgorithm.byok

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.engine.Js
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import kotlinx.serialization.json.jsonObject

/** web/test settings-validation, snapshot-logic and digests tests, and the BYOK model catalog. */
class ByokLogicTest {
    private val valid = ByokSettings(
        npub = "a".repeat(64), relays = listOf("wss://nos.lol"), apiBaseUrl = "http://localhost:11434/v1", apiKey = "",
        model = "local", userPrompt = "Cooking", hoursBack = 24, digestTopN = 15, batchSize = 20, concurrency = 1,
    )

    @Test
    fun `a keyless local model is supported, remote models need credentials`() {
        assertNull(SettingsValidation.setupProblem(valid))
        assertEquals(SetupField.ApiKey, SettingsValidation.setupProblem(valid.copy(apiBaseUrl = "https://api.venice.ai/api/v1"))?.field)
    }

    @Test
    fun `invalid identity, bounds and unsafe endpoints fail before saving`() {
        for (patch in listOf(
            valid.copy(npub = "nsec1private"), valid.copy(batchSize = -1), valid.copy(hoursBack = 99999), valid.copy(concurrency = 999),
            valid.copy(digestTopN = -5), valid.copy(batchSize = Int.MIN_VALUE), valid.copy(apiBaseUrl = "javascript:bad"),
            valid.copy(apiBaseUrl = "http://remote.example/v1"), valid.copy(relays = listOf("bad")), valid.copy(relays = emptyList()),
            valid.copy(userPrompt = "  "), valid.copy(userPrompt = "x".repeat(2001)), valid.copy(model = " "),
            valid.copy(apiBaseUrl = "https://api.example/v1?x=1", apiKey = "k"),
        )) assertNotNull(patch.toString(), SettingsValidation.setupProblem(patch))
        assertEquals("Use a whole number from 5 to 50.", SettingsValidation.validate(valid.copy(batchSize = 4)))
    }

    @Test
    fun `local endpoints are localhost and 127_0_0_1 only`() {
        assertNull(SettingsValidation.setupProblem(valid.copy(apiBaseUrl = "http://127.0.0.1:11434/v1")))
        assertEquals(SetupField.ApiBase, SettingsValidation.setupProblem(valid.copy(apiBaseUrl = "http://[::1]:11434/v1"))?.field)
    }

    @Test
    fun `decision scoring needs Venice`() {
        val p = SettingsValidation.setupProblem(valid.copy(scorer = "decision"))
        assertEquals(SetupField.Scorer, p?.field)
        assertTrue(p!!.isExtra)
        assertNull(SettingsValidation.setupProblem(valid.copy(scorer = "decision", apiBaseUrl = "https://api.venice.ai/api/v1", apiKey = "k")))
    }

    @Test
    fun `setup steps - each essential judged alone, the first missing one is next`() {
        val empty = ByokSettings()
        val steps = SettingsValidation.setupSteps(empty)
        assertEquals(listOf("Your public key (npub)", "What you care about, in your own words", "A model connection"), steps.map { it.label })
        assertEquals(listOf(SettingsValidation.StepState.Next, SettingsValidation.StepState.Todo, SettingsValidation.StepState.Todo), steps.map { it.state })
        assertEquals(SetupField.ApiKey, steps[2].field)
        val withKey = SettingsValidation.setupSteps(empty.copy(npub = "b".repeat(64), apiKey = "k"))
        assertEquals(listOf(SettingsValidation.StepState.Done, SettingsValidation.StepState.Next, SettingsValidation.StepState.Done), withKey.map { it.state })
        assertTrue(SettingsValidation.setupSteps(valid).all { it.state == SettingsValidation.StepState.Done })
    }

    @Test
    fun `the score namespace changes with words, model, scorer and learning, never with the key`() {
        val s = valid.copy(apiKey = "secret")
        assertEquals(ScoreCache.namespace(s), ScoreCache.namespace(s.copy(apiKey = "other")))
        assertTrue(ScoreCache.namespace(s).startsWith("a".repeat(64) + "_"))
        for (other in listOf(s.copy(userPrompt = "Bitcoin"), s.copy(model = "x"), s.copy(learnFromLikes = false), s.copy(scorer = "decision"))) {
            assertNotEquals(ScoreCache.namespace(s), ScoreCache.namespace(other))
        }
        // The decision scorer keys on its own model.
        assertEquals(ScoreCache.namespace(s.copy(scorer = "decision", model = "a")), ScoreCache.namespace(s.copy(scorer = "decision", model = "b")))
    }

    @Test
    fun `age, staleness and when to run by itself`() {
        assertEquals("", SnapshotLogic.ageLabel(null, 1000))
        assertEquals("Updated just now", SnapshotLogic.ageLabel(1000, 1030))
        assertEquals("Updated 12 min ago", SnapshotLogic.ageLabel(1000, 1000 + 12 * 60))
        assertEquals("Updated 3 h ago", SnapshotLogic.ageLabel(0, 3 * 3600))
        assertEquals("Updated 2 d ago", SnapshotLogic.ageLabel(0, 49 * 3600))
        val base = SnapshotLogic.AutoRunInput(enabled = true, ready = true, running = false, hidden = false, createdAt = 0, nowSec = 601)
        assertTrue(SnapshotLogic.shouldAutoRun(base))
        assertTrue(SnapshotLogic.shouldAutoRun(base.copy(createdAt = null)))
        assertFalse(SnapshotLogic.shouldAutoRun(base.copy(createdAt = 300)))
        assertTrue(SnapshotLogic.shouldAutoRun(base.copy(createdAt = 300, settingsChanged = true)))
        for (off in listOf(base.copy(enabled = false), base.copy(ready = false), base.copy(running = true), base.copy(hidden = true), base.copy(pausedUntil = 700), base.copy(attemptFailed = true))) {
            assertFalse(SnapshotLogic.shouldAutoRun(off))
        }
    }

    @Test
    fun `merging a new ranking into what is shown`() {
        assertEquals(SnapshotLogic.MergeAction.Render, SnapshotLogic.decideMerge(emptyList(), listOf("a"), true, false).action)
        assertEquals(SnapshotLogic.MergeDecision(SnapshotLogic.MergeAction.Keep, 0, true), SnapshotLogic.decideMerge(listOf("a", "b"), listOf("a", "b"), true, false))
        assertEquals(SnapshotLogic.MergeAction.Merge, SnapshotLogic.decideMerge(listOf("a"), listOf("b", "a"), false, false).action)
        assertEquals(SnapshotLogic.MergeDecision(SnapshotLogic.MergeAction.Pill, 2, false), SnapshotLogic.decideMerge(listOf("a"), listOf("b", "c", "a"), true, false))
        assertEquals(SnapshotLogic.MergeAction.Keep, SnapshotLogic.decideMerge(listOf("a", "b"), listOf("b", "a"), true, false).action)
        assertEquals(SnapshotLogic.MergeAction.Merge, SnapshotLogic.decideMerge(listOf("a"), listOf("b", "a"), true, true).action)
        assertEquals("1 new note", SnapshotLogic.pillLabel(1))
        assertEquals("3 new notes", SnapshotLogic.pillLabel(3))
        assertEquals(2, SnapshotLogic.countNew(listOf("a"), listOf("b", "b", "c", "a")))
    }

    @Test
    fun `fresh notes - what a run added, kept through a quiet re-rank`() {
        assertEquals(listOf("c"), SnapshotLogic.freshIds(listOf("a", "b"), listOf("c", "a", "b")))
        assertEquals(emptyList<String>(), SnapshotLogic.freshIds(emptyList(), listOf("a")))
        assertEquals(emptyList<String>(), SnapshotLogic.freshIds(listOf("a"), listOf("b", "c")))
        assertEquals(listOf("c"), SnapshotLogic.freshIds(listOf("a", "b", "c"), listOf("c", "a", "b"), listOf("c")))
        assertEquals(listOf("d"), SnapshotLogic.freshIds(listOf("a", "c"), listOf("d", "c", "a"), listOf("c")))
    }

    @Test
    fun `coverage says what was ranked, from which window, in which order`() {
        assertEquals("12 notes from 40 posts ranked in the last 24 h, new arrivals first, then best match.", SnapshotLogic.coverageText(12, 40, 24, "new"))
        assertEquals("1 note from 1 post ranked in the last 2 days, best match first. 1 not ranked yet; check the model connection.", SnapshotLogic.coverageText(1, 1, 48, "best", 1))
        assertTrue(SnapshotLogic.coverageText(300, 500, 24, "best").endsWith(" A busy window: only the newest 500 posts were ranked."))
        val boosted = listOf(post("x", type = PostType.Boost, original = "o"), post("y", type = PostType.Boost, original = "o"), post("z"))
        assertEquals(listOf("o", "z"), SnapshotLogic.foldedIds(boosted))
    }

    private fun post(id: String, score: Double = 5.0, type: PostType = PostType.Original, original: String? = null, author: String = "a".repeat(64), content: String = "post $id") =
        ScoredPost(id, type, author, content, 1000, originalPost = original?.let { EmbeddedPost(it, "c".repeat(64), "orig") }, score = score, rawEvent = NostrEvent(id, author, 1000, 1))

    @Test
    fun `history - newest first, deduplicated by id, capped`() {
        val list = (1..5).map { DigestRecord("d$it", it.toLong(), "t") }
        val out = LocalData.withDigest(list, DigestRecord("d3", 10, "again"), cap = 4)
        assertEquals(listOf("d3", "d5", "d4", "d2"), out.map { it.id })
        assertEquals("again", out[0].text)
    }

    @Test
    fun `a local digest keeps its notes and the profiles they need`() {
        val a = "a".repeat(64)
        val b = "b".repeat(64)
        val posts = listOf(
            post("1".repeat(64), 9.0, author = a),
            post("2".repeat(64), 8.0, author = b),
            post("not-hex", 7.0, author = a),
            post("3".repeat(64), 3.0, author = a),
        )
        val profiles = mapOf(a to ProfileData(a, name = "Alice", picture = "https://p", lud16 = "x@y"), "z".repeat(64) to ProfileData("z", name = "Nobody"))
        val d = LocalDigests.makeLocalDigest("  Good morning, nostrich!  ", posts, topN = 3, profiles = profiles, nowMs = 1_700_000_000_123)
        assertEquals("local-1700000000123", d.id)
        assertEquals(1_700_000_000L, d.createdAt)
        assertEquals("Good morning, nostrich!", d.text)
        assertNull(d.audioUrl)
        assertEquals(listOf("1".repeat(64), "2".repeat(64)), d.notes!!.map { it.id })
        assertEquals(setOf(a), d.profiles!!.keys)
        assertEquals("Alice", d.profiles!![a]!!.name)
        assertEquals(3, LocalDigests.wordCount(" one two\n\nthree "))
    }

    @Test
    fun `an oversize snapshot loses its lowest-ranked posts and the profiles only those needed`() {
        val a = "a".repeat(64)
        val b = "b".repeat(64)
        val posts = listOf(post("p1", author = a, content = "x".repeat(400)), post("p2", author = b, content = "y".repeat(400)))
        val snap = FeedSnapshot(createdAt = 1, posts = posts, profiles = mapOf(a to ProfileData(a, "A"), b to ProfileData(b, "B")))
        val small = LocalData.trim(snap, maxBytes = 1100)
        assertEquals(listOf("p1"), small.posts.map { it.id })
        assertEquals(setOf(a), small.profiles.keys)
        assertEquals(2, LocalData.trim(snap).posts.size)
        assertEquals(1, LocalData.trim(snap, maxPosts = 1).posts.size)
    }

    @Test
    fun `model catalog - Venice shape, recommendations, labels`() {
        val body = """{"data":[{"id":"kimi-k3","model_spec":{"availableContextTokens":262144,"pricing":{"input":{"usd":0.6},"output":{"usd":2.5}}}},{"id":"deepseek-v4-flash-0731","model_spec":{"availableContextTokens":1000000,"pricing":{"input":{"usd":0.18},"output":{"usd":0.35}}}},{"id":""},{"name":"no id"}]}"""
        val models = ModelCatalog.parseList(body)
        assertEquals(listOf("deepseek-v4-flash-0731", "kimi-k3"), models.map { it.id })
        assertEquals("1M ctx · $0.18/$0.35 per M", ModelCatalog.describe(models[0]))
        assertEquals("262k ctx · $0.6/$2.5 per M", ModelCatalog.describe(models[1]))
        assertEquals(SuggestedModels("deepseek-v4-flash-0731", "kimi-k3", "kimi-k3"), ModelCatalog.suggestModels("https://api.venice.ai/api/v1", models))
        assertEquals(SuggestedModels(), ModelCatalog.suggestModels("https://openrouter.ai/api/v1", models))
        assertEquals(listOf("llama3.2"), ModelCatalog.parseList("""{"models":[{"id":"llama3.2"}]}""").map { it.id })
        assertTrue(ModelCatalog.isVenice("https://api.venice.ai/api/v1"))
        assertFalse(ModelCatalog.isVenice("https://notvenice.example"))
        assertEquals("", ModelCatalog.describe(ModelCatalog.normalize(Js.parse("""{"id":"x"}""")!!.jsonObject)!!))
    }

    @Test
    fun `settings defaults match the web app`() {
        val d = ByokSettings()
        assertEquals("deepseek-v4-flash-0731", d.model)
        assertEquals("https://api.venice.ai/api/v1", d.apiBaseUrl)
        assertEquals(listOf("wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"), d.relays)
        assertEquals(listOf("wss://nostr.cypherpunk.today", "wss://nos.lol", "wss://relay.primal.net"), d.signerRelays)
        assertEquals("jev-latest", d.decisionModel)
        assertEquals("local", valid.copy(scorer = "chat").scoringModel)
        assertEquals("jev-latest", valid.copy(scorer = "decision").scoringModel)
    }
}
