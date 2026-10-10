package today.cypherpunk.nalgorithm.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.MediaMeta
import today.cypherpunk.nalgorithm.model.NostrEvent

class NoteContentTest {
    private fun hex(c: Char) = c.toString().repeat(64)

    @Test
    fun `imeta is read safely and bounded`() {
        val tags = listOf(
            listOf("imeta", "url https://i.example/a.jpg", "dim 1200x800", "alt A cat", "m image/JPEG"),
            listOf("imeta", "url javascript:alert(1)"),
            listOf("imeta", "url https://i.example/a.jpg", "dim 0x5"),
            listOf("imeta", "url https://v.example/b", "m video/mp4", "dim 99999x1"),
            listOf("p", "x"),
        )
        val out = NoteMedia.readImeta(tags)
        assertEquals(2, out.size)
        assertEquals(MediaMeta("https://i.example/a.jpg", 1200, 800, "A cat", "image/jpeg"), out[0])
        assertEquals(MediaMeta("https://v.example/b", 99999, 1, null, "video/mp4"), out[1])
        assertEquals(8, NoteMedia.readImeta(List(12) { listOf("imeta", "url https://i.example/$it.png") }).size)
    }

    @Test
    fun `media from imeta first, then media links in the text, each once`() {
        val meta = listOf(MediaMeta("https://v.example/clip", mime = "video/mp4"))
        val items = NoteMedia.extract("see https://i.example/x.png) and https://v.example/clip and https://i.example/x.png https://site.example/page", meta)
        assertEquals(listOf("https://v.example/clip", "https://i.example/x.png"), items.map { it.url })
        assertTrue(items[0].video)
        assertFalse(items[1].video)
        assertTrue(NoteMedia.isImageUrl("https://image.nostr.build/abc"))
        assertFalse(NoteMedia.isImageUrl("https://v.nostr.build/abc.mp4"))
        assertTrue(NoteMedia.isVideoUrl("https://x.example/a.MOV?t=1"))
    }

    @Test
    fun `link preview urls skip media, own host and repeats`() {
        val urls = LinkPreviews.extractPreviewUrls(
            "a https://news.example/story, b https://news.example/story#top c https://i.example/x.jpg d https://nostr.build/p e https://nalgorithm.cypherpunk.today/app/ f https://third.example/",
            "nalgorithm.cypherpunk.today",
            max = 5,
        )
        assertEquals(listOf("https://news.example/story", "https://third.example/"), urls)
        assertEquals(2, LinkPreviews.extractPreviewUrls("https://a.example https://b.example https://c.example").size)
        assertEquals(emptyList<String>(), LinkPreviews.extractPreviewUrls("https://user:pw@a.example/x"))
    }

    private fun ev(id: String, tags: List<List<String>>, createdAt: Long = 1, kind: Int = 1) =
        NostrEvent(id = id, pubkey = hex('p'), createdAt = createdAt, kind = kind, tags = tags)

    @Test
    fun `parent per NIP-10, marked and positional`() {
        val root = hex('1'); val parent = hex('2')
        assertEquals(parent, Thread.parentOf(ev("x", listOf(listOf("e", root, "", "root"), listOf("e", parent, "wss://r", "reply", hex('a')))))?.id)
        assertEquals(root, Thread.parentOf(ev("x", listOf(listOf("e", root, "", "root"))))?.id)
        assertEquals(parent, Thread.parentOf(ev("x", listOf(listOf("e", root), listOf("e", parent))))?.id)
        assertEquals("wss://r", Thread.parentOf(ev("x", listOf(listOf("e", root, "", "root"), listOf("e", parent, "wss://r", "reply"))))?.relay)
        assertNull(Thread.parentOf(ev("x", listOf(listOf("p", hex('a'))))))
        assertNull(Thread.parentOf(ev("x", listOf(listOf("e", "short")))))
    }

    @Test
    fun `direct replies only, oldest first, deduplicated and capped`() {
        val target = hex('f')
        val events = listOf(
            ev(hex('3'), listOf(listOf("e", target, "", "root")), createdAt = 30),
            ev(hex('1'), listOf(listOf("e", target, "", "root")), createdAt = 10),
            ev(hex('1'), listOf(listOf("e", target, "", "root")), createdAt = 10),
            ev(hex('2'), listOf(listOf("e", target, "", "root"), listOf("e", hex('e'), "", "reply")), createdAt = 20),
            ev(hex('4'), listOf(listOf("e", target, "", "root")), createdAt = 5, kind = 7),
        )
        assertEquals(listOf(hex('1'), hex('3')), Thread.directReplies(events, target).map { it.id })
        assertEquals(1, Thread.directReplies(events, target, limit = 1).size)
    }

    @Test
    fun `relative time - now, minutes, hours, days, then a date`() {
        val now = 1_700_000_000_000L
        val s = now / 1000
        assertEquals("now", NoteTime.relative(s, now))
        assertEquals("now", NoteTime.relative(s + 100, now))
        assertEquals("5m", NoteTime.relative(s - 300, now))
        assertEquals("2h", NoteTime.relative(s - 7200, now))
        assertEquals("3d", NoteTime.relative(s - 3 * 86400, now))
        val date = NoteTime.relative(s - 10 * 86400, now, java.util.Locale.US)
        assertTrue(date, Regex("^[A-Z][a-z]{2} \\d{1,2}$").matches(date))
    }

    @Test
    fun `day labels`() {
        val now = System.currentTimeMillis()
        assertEquals("Today", NoteTime.dayLabel(now / 1000, now))
        assertEquals("Yesterday", NoteTime.dayLabel(now / 1000 - 86400, now))
    }
}
