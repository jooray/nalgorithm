package today.cypherpunk.nalgorithm.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.DigestSourceNote
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ProfileSnapshot
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

class DigestModelTest {
    private fun digest(id: String, createdAt: Long, audioUrl: String? = null, durationSeconds: Double? = null) =
        DigestRecord(id = id, createdAt = createdAt, text = "Good morning", audioUrl = audioUrl, durationSeconds = durationSeconds)

    @Test fun `lengths and lines`() {
        assertEquals("3 min 52 s", formatLength(232.0))
        assertEquals("3 min", formatLength(180.0))
        assertEquals("45 s", formatLength(45.0))
        assertEquals("about 4 min", formatLength(238.0, true))
        assertEquals("about 1 min", formatLength(10.0, true))
        assertEquals(100.0, estimateSeconds(List(260) { "word" }.joinToString(" ")), 0.0)
        assertEquals("Good morning. Second.", firstLines("\n Good morning.\n\nSecond.\nThird.", 2))
        val sorted = newestFirst(listOf(digest("a", 1), digest("b", 3), digest("c", 3)))
        assertEquals(listOf("b", "c", "a"), sorted.map { it.id })
    }

    @Test fun `length label - server length first, the player figure after, a guess last`() {
        val text = "word ".repeat(300)
        assertEquals("3 min 47 s", digestLengthLabel(0.0, false, 227.448, text))
        assertEquals("3 min 47 s", digestLengthLabel(205.0, false, 227.448, text))
        assertTrue(Regex("^about \\d+ min$").matches(digestLengthLabel(205.0, false, null, text)))
        assertEquals("3 min 47 s", digestLengthLabel(227.0, true, null, text))
        assertTrue(Regex("^about \\d+ min$").matches(digestLengthLabel(0.0, false, null, text)))
        assertTrue(digestLengthLabel(0.0, false, 0.0, text).startsWith("about"))
    }

    @Test fun `keys follow the audio link, else the id`() {
        assertEquals("audio:https://x/a.mp3", keyOf(digest("1", 1, "https://x/a.mp3")))
        assertEquals("digest:local-5", keyOf(digest("local-5", 1)))
        assertEquals("digest:2", keyOf(digest("2", 1, "javascript:alert(1)")))
    }

    @Test fun `exact seconds only with real audio`() {
        assertEquals(227.4, exactSeconds(digest("1", 1, "https://x/a.mp3", 227.4))!!, 0.0)
        assertNull(exactSeconds(digest("1", 1, null, 227.4)))
        assertNull(exactSeconds(digest("1", 1, "https://x/a.mp3", 0.0)))
    }

    @Test fun `safe audio urls are http(s) only`() {
        assertEquals("https://a.b/c.mp3", safeAudioUrl("https://a.b/c.mp3"))
        assertEquals("http://a.b/c.mp3", safeAudioUrl("http://a.b/c.mp3"))
        assertNull(safeAudioUrl("file:///etc/passwd"))
        assertNull(safeAudioUrl("javascript:x"))
        assertNull(safeAudioUrl(null))
    }

    @Test fun `mp3 file names use the UTC date like the web`() {
        // 2026-10-08T23:30Z, which is already the 9th east of UTC.
        assertEquals("nalgorithm-2026-10-08-42.mp3", mp3FileName(digest("42", 1791502200)))
        assertEquals("nalgorithm-digest-2026-10-08.mp3", madeAudioFileName(digest("local-1", 1791502200)))
    }

    @Test fun `show notes become renderable posts with the kind kept`() {
        val note = DigestSourceNote(id = "e".repeat(64), pubkey = "a".repeat(64), createdAt = 10, content = "hi", score = 7.5, reason = "why", kind = 30023)
        val post = toScoredPost(note)
        assertEquals(PostType.Original, post.type)
        assertEquals(note.pubkey, post.author)
        assertEquals("why", post.justification)
        assertEquals(30023, post.rawEvent!!.kind)
        assertEquals(1, toScoredPost(note.copy(kind = null)).rawEvent!!.kind)
    }

    @Test fun `note profiles - live ones win over the digest's snapshot`() {
        val a = "a".repeat(64); val b = "b".repeat(64); val c = "c".repeat(64)
        val got = notesProfiles(
            mapOf(a to ProfileSnapshot(name = "old a"), b to ProfileSnapshot(name = "snap b")),
            mapOf(a to ProfileData(pubkey = a, name = "live a")),
            listOf(a, b, c),
        )
        assertEquals("live a", got[a]?.name)
        assertEquals("snap b", got[b]?.name)
        assertNull(got[c])
        assertEquals(listOf(a, b), notePubkeys(listOf(
            DigestSourceNote(id = "1", pubkey = a, createdAt = 1, content = "", score = 1.0),
            DigestSourceNote(id = "2", pubkey = b, createdAt = 1, content = "", score = 1.0),
            DigestSourceNote(id = "3", pubkey = a, createdAt = 1, content = "", score = 1.0),
        )))
    }

    @Test fun `day labels`() {
        val zone = ZoneId.of("Europe/Bratislava")
        val now = LocalDateTime.of(2026, 10, 9, 9, 0).atZone(zone).toInstant().toEpochMilli()
        val sec = { d: Int, h: Int -> LocalDateTime.of(2026, 10, d, h, 30).atZone(zone).toEpochSecond() }
        assertEquals("Today", DigestLabels.dayLabel(sec(9, 7), now, zone, Locale.UK))
        assertEquals("Yesterday", DigestLabels.dayLabel(sec(8, 23), now, zone, Locale.UK))
        assertEquals("Tue 6 Oct", DigestLabels.dayLabel(sec(6, 7), now, zone, Locale.UK))
        DigestLabels.use24Hour = true
        assertEquals("07:30", DigestLabels.clockLabel(sec(9, 7), zone, Locale.UK))
    }

    @Test fun `paragraphs split on blank lines`() {
        assertEquals(listOf("One.", "Two\nlines."), paragraphs("One.\n\n\nTwo\nlines.\n\n "))
    }
}
