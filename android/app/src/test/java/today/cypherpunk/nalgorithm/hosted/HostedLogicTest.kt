package today.cypherpunk.nalgorithm.hosted

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ScoredPost
import java.time.Instant

/** Ports of web/test/hosted-logic, previews, digest-job-logic and snapshot-logic tests. */
class HostedLogicTest {
    private val fmt: (Long) -> String = { "D$it" }
    private fun json(text: String) = Json.parseToJsonElement(text)
    private fun err(status: Int, code: String? = null, message: String = "") = ApiError(status, message, code)

    @Test fun `buildLoginTemplate binds url, method and nonce`() {
        val t = buildLoginTemplate("ab".repeat(32), "https://x.test/api/auth/login", "n1", 1_700_000_000)
        assertEquals(27235, t.kind)
        assertEquals(1_700_000_000L, t.createdAt)
        assertEquals("", t.content)
        assertEquals(listOf(listOf("u", "https://x.test/api/auth/login"), listOf("method", "POST"), listOf("nonce", "n1")), t.tags)
    }

    @Test fun `daysForSats is pro rata per plan`() {
        assertEquals(30.0, daysForSats(Plan.Nalgorithm, 10000), 0.0)
        assertEquals(15.0, daysForSats(Plan.Nalgorithm, 5000), 0.0)
        assertEquals(3.0, daysForSats(Plan.Nalgorithm, 1000), 0.0)
        assertEquals(30.0, daysForSats(Plan.AllAccess, 25000), 0.0)
        assertEquals(6.0, daysForSats(Plan.AllAccess, 5000), 0.0)
        assertEquals(3.7, daysForSats(Plan.Nalgorithm, 1234), 1e-9)
        assertEquals(0.0, daysForSats(Plan.Nalgorithm, 0), 0.0)
        assertEquals(0.0, daysForSats(Plan.Nalgorithm, null), 0.0)
    }

    @Test fun `formatDays and formatSats`() {
        assertEquals("30 days", formatDays(30.0))
        assertEquals("1 day", formatDays(1.0))
        assertEquals("7.5 days", formatDays(7.5))
        assertEquals("10,000 sats", formatSats(10000))
        assertEquals("1,000 sats", formatSats(1000))
        assertEquals("1,234,567 sats", formatSats(1234567))
    }

    @Test fun `validateSats enforces whole numbers and the minimum`() {
        assertNull(validateSats(1000))
        assertNull(validateSats(25000))
        assertTrue(validateSats(999)!!.contains("minimum"))
        assertTrue(validateSats(null)!!.contains("whole number"))
        assertTrue(validateSats(parseWholeNumber("1500.5"))!!.contains("whole number"))
        assertEquals("10,000 sats buys about 30 days.", payDaysText(Plan.Nalgorithm, "10000"))
        assertEquals("5,000 sats buys about 6 days.", payDaysText(Plan.AllAccess, "5000"))
        assertEquals("The minimum is 1,000 sats.", payDaysText(Plan.Nalgorithm, "10"))
    }

    @Test fun `parseWholeNumber is strict`() {
        assertEquals(42L, parseWholeNumber(" 42 "))
        assertNull(parseWholeNumber(""))
        assertNull(parseWholeNumber("2.5"))
        assertNull(parseWholeNumber("1e3"))
        assertNull(parseWholeNumber("-3"))
    }

    @Test fun `validateHostedSettings mirrors the server limits`() {
        assertNull(validateHostedSettings("bitcoin", 24, 15))
        assertNull(validateHostedSettings("x".repeat(2000), 24, 15))
        assertTrue(validateHostedSettings("x".repeat(2001), 24, 15)!!.contains("2000"))
        assertNull(validateHostedSettings("b", 72, 15))
        assertTrue(validateHostedSettings("b", 73, 15)!!.contains("72"))
        assertTrue(validateHostedSettings("b", 0, 15)!!.contains("hours"))
        assertTrue(validateHostedSettings("b", null, 15)!!.contains("hours"))
        assertNull(validateHostedSettings("b", 24, 30))
        assertTrue(validateHostedSettings("b", 24, 31)!!.contains("30"))
        assertTrue(validateHostedSettings("b", 24, 0)!!.contains("Posts"))
    }

    @Test fun `daysLeft counts a started day and never goes negative`() {
        assertEquals(3L, daysLeft(1000 + 86400 * 3L, 1000))
        assertEquals(3L, daysLeft(1000 + 86400 * 2L + 1, 1000))
        assertEquals(1L, daysLeft(1000 + 60L, 1000))
        assertEquals(0L, daysLeft(500, 1000))
        assertEquals(0L, daysLeft(null, 1000))
    }

    @Test fun `entitlementView per state`() {
        val now = 1000L
        val trial = entitlementView(Entitlement("trial", now + 86400 * 2), now, fmt)
        assertEquals("Free trial: 2 days left", trial.text)
        assertTrue(trial.canRank)
        assertEquals("Free trial: 1 day left", entitlementView(Entitlement("trial", now + 10), now, fmt).text)
        val active = entitlementView(Entitlement("active", 5000), now, fmt)
        assertEquals("Subscribed until D5000", active.text)
        assertEquals("Add time", active.actionLabel)
        assertTrue(active.banner)
        val expired = entitlementView(Entitlement("expired"), now, fmt)
        assertFalse(expired.canRank)
        assertEquals("Subscribe", expired.actionLabel)
        val none = entitlementView(Entitlement("none"), now, fmt)
        assertTrue(none.canRank)
        assertTrue(none.text.contains("3-day trial"))
        assertEquals("unknown", entitlementView(Entitlement("unknown"), now, fmt).kind)
    }

    @Test fun `the banner hides while a subscription has more than 90 days left`() {
        val now = 1000L
        val day = 86400L
        assertFalse(entitlementView(Entitlement("active", now + 91 * day), now, fmt).banner)
        assertTrue(entitlementView(Entitlement("active", now + 89 * day), now, fmt).banner)
        assertTrue(entitlementView(Entitlement("active"), now, fmt).banner)
        assertTrue(entitlementView(Entitlement("trial", now + 2 * day), now, fmt).banner)
        assertTrue(entitlementView(Entitlement("expired"), now, fmt).banner)
    }

    @Test fun `Entitlement read is defensive`() {
        assertEquals(Entitlement("trial", 99), Entitlement.read(json("""{"state":"trial","until":99}""")))
        assertEquals(Entitlement("unknown"), Entitlement.read(json("""{"state":"weird"}""")))
        assertEquals(Entitlement("unknown"), Entitlement.read(JsonNull))
        assertEquals(Entitlement("active"), Entitlement.read(json("""{"state":"active","until":"soon"}""")))
    }

    @Test fun `paymentConfirmed`() {
        assertTrue(paymentConfirmed(Entitlement("expired"), Entitlement("active", 10)))
        assertTrue(paymentConfirmed(Entitlement("trial", 5), Entitlement("active", 10)))
        assertTrue(paymentConfirmed(null, Entitlement("active", 10)))
        assertFalse(paymentConfirmed(Entitlement("expired"), Entitlement("expired")))
        assertFalse(paymentConfirmed(Entitlement("trial", 5), Entitlement("trial", 5)))
        // Top-up while already subscribed: only a later end date counts.
        assertFalse(paymentConfirmed(Entitlement("active", 10), Entitlement("active", 10)))
        assertTrue(paymentConfirmed(Entitlement("active", 10), Entitlement("active", 99)))
    }

    @Test fun `describeError maps status and code to a message and action`() {
        assertEquals(ErrorAction.Login, describeError(401).action)
        assertEquals("Your session has ended. Sign in again to continue.", describeError(401).message)
        assertEquals(ErrorAction.Settings, describeError(400, "no_prompt").action)
        assertTrue(describeError(400, "no_prompt").message.contains("prompt"))
        assertEquals("That was not accepted: unknown plan", describeError(400, null, "unknown plan").message)
        assertEquals(ErrorAction.Pay, describeError(402, "paywall").action)
        assertTrue(describeError(429, "in_progress").message.contains("in progress"))
        assertTrue(describeError(429, "daily_cap").message.contains("daily limit"))
        assertTrue(describeError(429).message.contains("Too many"))
        assertTrue(describeError(503, "billing_unavailable").message.contains("Billing"))
        assertTrue(describeError(502, null, "payments are unavailable right now").message.contains("Payments"))
        assertTrue("a proxy 502 is not about payments", describeError(502).message.contains("server had a problem"))
        assertTrue(describeError(503, "busy").message.contains("busy"))
        assertTrue(describeError(0, "network").message.contains("reach the server"))
        assertTrue(describeError(500).message.contains("server had a problem"))
        assertEquals("teapot", describeError(418, null, "teapot").message)
        assertEquals("Something went wrong.", describeError(418).message)
    }

    @Test fun `describeDigestNowError`() {
        assertEquals("Digest delivery is not switched on for this server yet.", describeDigestNowError(err(503, "digests_unavailable")).message)
        assertTrue(describeDigestNowError(err(429, "daily_cap")).message.contains("digests"))
        assertEquals(ErrorAction.Pay, describeDigestNowError(err(402)).action)
        assertEquals(ErrorAction.Login, describeDigestNowError(err(401)).action)
    }

    @Test fun `isHttpUrl and safeAudioUrl only accept http(s)`() {
        assertTrue(isHttpUrl("https://pay.example/i/1"))
        assertFalse(isHttpUrl("javascript:alert(1)"))
        assertFalse(isHttpUrl("not a url"))
        assertFalse(isHttpUrl(null))
        assertEquals("https://cdn.example/a.mp3", safeAudioUrl("https://cdn.example/a.mp3"))
        assertNull(safeAudioUrl("data:audio/mpeg;base64,AAAA"))
        assertNull(safeAudioUrl(null))
    }

    @Test fun `digest voices - 24 Kokoro voices with readable labels`() {
        assertEquals(24, DIGEST_VOICES.size)
        assertEquals(Voice("af_bella", "Bella (US, female)"), DIGEST_VOICES[0])
        assertTrue(DIGEST_VOICES.contains(Voice("bm_fable", "Fable (UK, male)")))
        assertTrue(DIGEST_VOICES.contains(Voice("am_onyx", "Onyx (US, male)")))
        assertTrue(SAMPLE_VOICE_IDS.all(::isKnownVoice))
    }

    @Test fun `time and zone validation`() {
        assertTrue(isValidTime("07:30") && isValidTime("23:59") && isValidTime("00:00"))
        assertFalse(isValidTime("24:00") || isValidTime("7:30") || isValidTime("") || isValidTime(null))
        assertTrue(isValidTimeZone("Europe/Bratislava") && isValidTimeZone("UTC"))
        assertTrue("Intl accepts any case", isValidTimeZone("europe/bratislava"))
        assertFalse(isValidTimeZone("Mars/Base") || isValidTimeZone("") || isValidTimeZone(null))
    }

    @Test fun `validateScheduleForm reports the first problem`() {
        assertNull(validateScheduleForm("07:30", "Europe/Bratislava", null))
        assertNull(validateScheduleForm("07:30", "Europe/Bratislava", "af_bella"))
        assertTrue(validateScheduleForm("", "Europe/Bratislava", null)!!.contains("time of day"))
        assertTrue(validateScheduleForm("07:30", "Nowhere/City", null)!!.contains("time zone"))
        assertTrue(validateScheduleForm("07:30", "Europe/Bratislava", "nope")!!.contains("voice"))
    }

    @Test fun `defaultTimeZone only replaces a never-set schedule`() {
        assertEquals("Europe/Bratislava", defaultTimeZone("UTC", false, "Europe/Bratislava"))
        assertEquals("UTC", defaultTimeZone("UTC", true, "Europe/Bratislava"))
        assertEquals("Asia/Tokyo", defaultTimeZone("Asia/Tokyo", false, "Europe/Bratislava"))
        assertEquals("UTC", defaultTimeZone("UTC", false, "garbage"))
        assertEquals("UTC", defaultTimeZone("UTC", false, null))
    }

    private fun utc(text: String) = Instant.parse(text).epochSecond

    @Test fun `formatInZone shows the wall clock of the chosen zone`() {
        val sec = utc("2026-10-01T05:30:00Z")
        assertEquals("Thu 1 Oct, 07:30", formatInZone(sec, "Europe/Bratislava"))
        assertEquals("Thu 1 Oct, 05:30", formatInZone(sec, "UTC"))
        assertEquals("Thu 1 Oct, 00:05", formatInZone(utc("2026-10-01T00:05:00Z"), "UTC"))
        assertEquals("Thu 1 Oct, 18:30", formatInZone(sec, "Pacific/Auckland"))
    }

    @Test fun `nextRunText and scheduleLine`() {
        val sec = utc("2026-10-01T05:30:00Z")
        assertEquals("Next digest: Thu 1 Oct, 07:30", nextRunText(Schedule(enabled = true, nextRunAt = sec, tz = "Europe/Bratislava")))
        assertTrue(nextRunText(Schedule(enabled = false)).contains("off"))
        assertEquals("", nextRunText(Schedule(enabled = true, nextRunAt = null)))
        assertEquals("", scheduleLine(null))
        assertEquals("Daily delivery is off. Digests come only when you ask.", scheduleLine(Schedule(enabled = false)))
        assertEquals("Daily delivery is on.", scheduleLine(Schedule(enabled = true)))
        assertEquals("Daily delivery is on. Next: Thu 1 Oct, 07:30 (Europe/Bratislava).", scheduleLine(Schedule(enabled = true, nextRunAt = sec, tz = "Europe/Bratislava")))
    }

    @Test fun `lastStatusText covers every server status`() {
        for (s in listOf("sent", "delivery_pending", "no_prompt", "not_entitled", "billing_unavailable", "capped", "no_posts", "failed")) {
            assertTrue(s, lastStatusText(s).startsWith("Last digest"))
        }
        assertTrue(lastStatusText("not_entitled").contains("subscription has ended"))
        assertEquals("", lastStatusText(null))
        assertEquals("", lastStatusText("something_new"))
    }

    @Test fun `the schedule nudge names the zone and the time`() {
        assertTrue(nudgeText("Europe/Bratislava").startsWith("I write it at 07:30 Europe/Bratislava and send it by Nostr DM"))
    }

    @Test fun `feed progress reads as a place in line or a count, never a bare spinner`() {
        assertEquals(FeedProgress.Queued(2, 9), readFeedProgress(json("""{"state":"queued","ahead":2.7,"startedAt":9}""")))
        assertEquals(FeedProgress.Idle, readFeedProgress(json("""{"state":"weird"}""")))
        assertEquals(FeedProgress.Idle, readFeedProgress(null))
        assertTrue(Regex("2 rankings ahead of yours.*12s").containsMatchIn(describeProgress(FeedProgress.Queued(2, 0), 12)))
        assertTrue(describeProgress(FeedProgress.Queued(1, 0), 3).contains("1 ranking ahead"))
        assertTrue(describeProgress(FeedProgress.Queued(0, 0), 3).contains("next in line"))
        assertTrue(describeProgress(FeedProgress.Ranking(40, 120, 0), 30).contains("Ranking 40 of 120 new notes"))
        assertTrue(describeProgress(FeedProgress.Fetching(0), 2).contains("Fetching notes"))
        assertTrue(describeProgress(null, 5).contains("up to a minute (5s so far)"))
    }

    // ─── digest job ──────────────────────────────────────────────────────────

    @Test fun `digest status is read defensively`() {
        assertEquals(DigestStatus.IDLE, DigestStatus.read(json("\"x\"")))
        val s = DigestStatus.read(json("""{"running":true,"startedAt":100,"lastDurationSeconds":130,"lastStatus":"sent","finishedAt":null}"""))
        assertEquals(DigestStatus(true, 100, 130.0, "sent", null), s)
        assertFalse(DigestStatus.read(json("""{"running":"yes"}""")).running)
    }

    @Test fun `progress text and estimates`() {
        assertEquals("0:05", clock(5))
        assertEquals("2:03", clock(123))
        assertEquals("usually a few minutes", estimateText(null))
        assertEquals("usually about a minute", estimateText(60.0))
        assertEquals("usually about 3 minutes", estimateText(170.0))
        assertEquals(
            "Writing your digest… 1:05 so far, usually about 2 minutes. It will appear here and arrive by DM.",
            progressText(DigestStatus(running = true, startedAt = 1000, lastDurationSeconds = 120.0), 1065),
        )
    }

    @Test fun `only a running-to-finished change is news`() {
        assertEquals(JobStep.None, nextJobStep(false, DigestStatus(lastStatus = "sent")))
        assertEquals(JobStep.None, nextJobStep(true, DigestStatus(running = true)))
        assertEquals(JobStep.Arrived(false), nextJobStep(true, DigestStatus(lastStatus = "sent")))
        assertEquals(JobStep.Arrived(true), nextJobStep(true, DigestStatus(lastStatus = "delivery_pending")))
        val failed = nextJobStep(true, DigestStatus(lastStatus = "not_entitled")) as JobStep.Failed
        assertEquals(ErrorAction.Pay, failed.action)
        assertTrue((nextJobStep(true, DigestStatus(lastStatus = "interrupted")) as JobStep.Failed).message.contains("server restart"))
        assertEquals("The digest could not be written. Try again in a few minutes.", failureFor("odd").message)
    }

    @Test fun `the first digest is asked once, after a ranking, for someone without digests`() {
        assertTrue(shouldRequestFirstDigest(true, 3, 0, true, false, false, false))
        assertFalse(shouldRequestFirstDigest(false, 3, 0, true, false, false, false))
        assertFalse(shouldRequestFirstDigest(true, 0, 0, true, false, false, false))
        assertFalse(shouldRequestFirstDigest(true, 3, 1, true, false, false, false))
        assertFalse(shouldRequestFirstDigest(true, 3, 0, false, false, false, false))
        assertFalse(shouldRequestFirstDigest(true, 3, 0, true, true, false, false))
        assertFalse(shouldRequestFirstDigest(true, 3, 0, true, false, true, false))
        assertFalse(shouldRequestFirstDigest(true, 3, 0, true, false, false, true))
    }

    @Test fun `arrivals are found from an empty list and while the job still runs`() {
        val list = listOf(today.cypherpunk.nalgorithm.model.DigestRecord("2", 200, ""), today.cypherpunk.nalgorithm.model.DigestRecord("1", 100, ""))
        assertEquals("2", findArrived(listOf("1"), list)?.id)
        assertEquals("2", findArrived(emptyList(), list)?.id)
        assertNull(findArrived(listOf("1", "2"), list))
        assertTrue(readyDuringRun(DigestStatus(running = true, startedAt = 150), list))
        assertFalse(readyDuringRun(DigestStatus(running = true, startedAt = 250), list))
        assertFalse(readyDuringRun(DigestStatus(running = false, startedAt = 150), list))
        assertEquals("Your digest has arrived.", arrivalText("sent"))
    }

    // ─── snapshot logic ──────────────────────────────────────────────────────

    private val now = 1_800_000_000L

    @Test fun `ageLabel`() {
        assertEquals("", ageLabel(null, now))
        assertEquals("Updated just now", ageLabel(now - 20, now))
        assertEquals("Updated 1 min ago", ageLabel(now - 60, now))
        assertEquals("Updated 59 min ago", ageLabel(now - 59 * 60, now))
        assertEquals("Updated 1 h ago", ageLabel(now - 3600, now))
        assertEquals("Updated 47 h ago", ageLabel(now - 47 * 3600, now))
        assertEquals("Updated 3 d ago", ageLabel(now - 72 * 3600, now))
        assertEquals("Updated just now", ageLabel(now + 500, now))
    }

    @Test fun `shouldAutoRun`() {
        assertTrue(shouldAutoRun(true, false, false, now - 3600, now))
        assertTrue(shouldAutoRun(true, false, false, null, now))
        assertFalse(shouldAutoRun(true, false, false, now - 120, now))
        assertTrue(shouldAutoRun(true, false, false, now - 30, now, settingsChanged = true))
        assertFalse(shouldAutoRun(false, false, false, now - 3600, now))
        assertFalse(shouldAutoRun(true, true, false, now - 3600, now))
        assertFalse(shouldAutoRun(true, false, true, now - 3600, now))
        assertFalse(shouldAutoRun(true, false, false, now - 3600, now, pausedUntil = now + 1))
        assertTrue(shouldAutoRun(true, false, false, now - 3600, now, pausedUntil = now))
        assertFalse(shouldAutoRun(true, false, false, now - 3600, now, attemptFailed = true))
        assertFalse(isStale(now - STALE_AFTER_SECONDS + 1, now))
        assertTrue(isStale(now - STALE_AFTER_SECONDS, now))
    }

    @Test fun `decideMerge`() {
        assertEquals(MergeDecision(MergeAction.Render, 2, false), decideMerge(emptyList(), listOf("a", "b"), true, true, false))
        assertEquals(MergeDecision(MergeAction.Keep, 0, true), decideMerge(listOf("a", "b"), listOf("a", "b"), false, true, false))
        assertEquals(MergeDecision(MergeAction.Merge, 1, false), decideMerge(listOf("a", "b"), listOf("c", "a", "b"), true, true, false))
        assertEquals(MergeDecision(MergeAction.Pill, 2, false), decideMerge(listOf("a", "b"), listOf("c", "d", "a", "b"), false, true, false))
        assertEquals(MergeAction.Keep, decideMerge(listOf("a", "b"), listOf("b", "a"), false, true, false).action)
        assertEquals(MergeAction.Keep, decideMerge(listOf("a", "b"), listOf("a"), false, true, false).action)
        assertEquals(MergeAction.Merge, decideMerge(listOf("a"), listOf("b", "a"), false, true, true).action)
        assertEquals(MergeAction.Merge, decideMerge(listOf("a"), listOf("b", "a"), false, false, false).action)
        assertEquals(2, countNew(listOf("a"), listOf("a", "b", "b", "c")))
        assertEquals("1 new note", pillLabel(1))
        assertEquals("7 new notes", pillLabel(7))
    }

    @Test fun `freshIds`() {
        assertEquals(listOf("x", "y"), freshIds(listOf("a", "b", "c"), listOf("x", "a", "y", "b")))
        assertEquals(emptyList<String>(), freshIds(emptyList(), listOf("a", "b")))
        assertEquals(emptyList<String>(), freshIds(listOf("a"), listOf("x", "y"), listOf("a")))
        assertEquals(listOf("y", "x"), freshIds(listOf("a", "x", "y"), listOf("y", "a", "x"), listOf("x", "y", "gone")))
        assertEquals(emptyList<String>(), freshIds(listOf("a", "b"), listOf("b", "a"), emptyList()))
        assertEquals(listOf("z"), freshIds(listOf("a", "x"), listOf("z", "x", "a"), listOf("x")))
    }

    @Test fun `foldedIds counts a boost as the note it boosts`() {
        fun post(id: String, type: PostType = PostType.Original, orig: String? = null) =
            ScoredPost(id, type, "a", "", 1, originalPost = orig?.let { EmbeddedPost(it, "b", "") })
        assertEquals(listOf("n1", "n2"), foldedIds(listOf(post("n1"), post("b1", PostType.Boost, "n2"), post("b2", PostType.Boost, "n1"))))
    }

    @Test fun `quietNotice and coverageText`() {
        assertTrue(quietNotice(429, "daily_cap")!!.text.contains("Daily limit"))
        assertEquals(3600L, quietNotice(429, "daily_cap")!!.pauseSeconds)
        assertTrue(quietNotice(503, "billing_unavailable")!!.text.contains("unavailable"))
        assertTrue(quietNotice(0, "network")!!.text.contains("Offline"))
        assertEquals("", quietNotice(429, "in_progress")!!.text)
        assertTrue(quietNotice(503, "busy")!!.text.contains("busy"))
        assertNull(quietNotice(401, null))
        assertNull(quietNotice(402, "paywall"))
        assertNull(quietNotice(400, "no_prompt"))
        assertEquals("87 notes from 240 posts ranked in the last 24 h, new arrivals first, then best match.", coverageText(87, 240, 24, "new"))
        assertEquals("1 note from 1 post ranked in the last 3 days, best match first.", coverageText(1, 1, 72, "best"))
        assertTrue(coverageText(100, 500, 24, "best").contains("only the newest 500 posts were ranked"))
    }

    // ─── link previews ───────────────────────────────────────────────────────

    @Test fun `extractPreviewUrls - first two page links, in order`() {
        val text = "read https://a.example/one and https://b.example/two, also https://c.example/three"
        assertEquals(listOf("https://a.example/one", "https://b.example/two"), extractPreviewUrls(text))
        assertEquals(3, extractPreviewUrls(text, "", 3).size)
        assertEquals(emptyList<String>(), extractPreviewUrls("no links here"))
    }

    @Test fun `extractPreviewUrls - skips media and image hosts that render inline`() {
        val text = listOf(
            "https://a.example/pic.PNG", "https://a.example/clip.mp4", "https://a.example/song.mp3",
            "https://image.nostr.build/abc", "https://nostr.build/i/x", "https://a.example/drawing.svg", "https://a.example/article",
        ).joinToString(" ")
        assertEquals(listOf("https://a.example/article"), extractPreviewUrls(text))
    }

    @Test fun `extractPreviewUrls - skips the app host, duplicates, fragment duplicates and credentials`() {
        val text = "https://app.example/x https://a.example/p https://a.example/p#top https://a.example/p https://u:pw@b.example/ https://b.example/q"
        assertEquals(listOf("https://a.example/p", "https://b.example/q"), extractPreviewUrls(text, "app.example"))
    }

    @Test fun `extractPreviewUrls - trailing punctuation and non-http schemes`() {
        assertEquals(listOf("https://a.example/p", "https://b.example/q"), extractPreviewUrls("(see https://a.example/p). Also https://b.example/q!"))
        assertEquals(emptyList<String>(), extractPreviewUrls("ftp://a.example/x javascript:alert(1) nostr:npub1abc"))
        assertEquals(listOf("https://ok.example/"), extractPreviewUrls("https://[bad https://ok.example/"))
    }

    @Test fun `safeImagePath only lets the server image path through`() {
        val good = "preview/image?u=aHR0cHM6Ly9leC5jb20vYS5wbmc&s=abc_DEF-123"
        assertEquals(good, safeImagePath(good))
        for (bad in listOf(
            "https://evil.example/x.png", "//evil.example/x.png", "/preview/image?u=a&s=b", "preview/image?u=a&s=b&x=1", "javascript:alert(1)",
            "preview/image?u=a b&s=b", "data:image/png;base64,AAAA", "../preview/image?u=a&s=b", "preview/image?u=a&s=", null,
        )) {
            assertEquals(bad.toString(), "", safeImagePath(bad))
        }
    }

    @Test fun `readLinkCard - unavailable and junk give null, text is capped, the image is vetted`() {
        assertNull(readLinkCard(json("""{"unavailable":true}""")))
        assertNull(readLinkCard(JsonNull))
        assertNull(readLinkCard(json("\"x\"")))
        assertNull(readLinkCard(json("""{"title":"","description":""}""")))
        assertNull(readLinkCard(json("""{"title":5}""")))
        val c = readLinkCard(json("""{"title":"${"T".repeat(500)}","description":"D","siteName":"s","image":"https://evil.example/i.png"}"""))!!
        assertEquals(200, c.title.length)
        assertEquals("", c.image)
        assertEquals("<b>only</b>", readLinkCard(json("""{"description":"<b>only</b>"}"""))!!.description)
    }

    @Test fun `previewsEnabled - on unless the setting is exactly false`() {
        assertTrue(previewsEnabled(true))
        assertTrue(previewsEnabled(null))
        assertFalse(previewsEnabled(false))
    }

    // ─── digests ─────────────────────────────────────────────────────────────

    @Test fun `readDigest validates untrusted digests and notes`() {
        val hex = "a".repeat(64)
        val d = readDigest(json(
            """{"id":12,"createdAt":1700000000,"text":"Hi","audioUrl":"https://x/a.mp3","durationSeconds":0,
               "notes":[{"id":"${hex.uppercase()}","pubkey":"$hex","createdAt":1,"content":"c","score":12,"reason":"  why ","relay":"wss://r"},
                        {"id":"short","pubkey":"$hex","createdAt":1,"content":"c","score":1}]}""",
        ))!!
        assertEquals("12", d.id)
        assertNull("zero duration is no duration", d.durationSeconds)
        assertEquals(1, d.notes!!.size)
        assertEquals(hex, d.notes[0].id)
        assertEquals(10.0, d.notes[0].score, 0.0)
        assertEquals("why", d.notes[0].reason)
        assertNull("a summary has no notes, distinct from none", readDigest(json("""{"id":"1","createdAt":1}"""))!!.notes)
        assertNull(readDigest(json("""{"id":"","createdAt":1}""")))
        assertNull(readDigest(json("""{"id":"1"}""")))
    }
}
