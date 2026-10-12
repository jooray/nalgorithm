package today.cypherpunk.nalgorithm.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.ui.notes.NoteMarkdown.Piece
import today.cypherpunk.nalgorithm.ui.notes.NoteMarkdown.Style

/** web/test/markdown.test.mjs, case for case. */
class NoteMarkdownTest {
    private fun texts(pieces: List<Piece>) = pieces.joinToString("") {
        when (it) {
            is Piece.Text -> it.text
            is Piece.Link -> "[${it.label}]"
            is Piece.Token -> "<${it.token::class.simpleName}>"
        }
    }
    private fun List<Piece>.text(t: String) = first { it is Piece.Text && it.text == t }

    @Test
    fun `bold, italic, code and strike lose their markers`() {
        val p = NoteMarkdown.format("Ships **Amethyst Desktop** and *more*, `npm i` ~~old~~ __done__ _ok_")
        assertEquals("Ships Amethyst Desktop and more, npm i old done ok", texts(p))
        assertEquals(Style(bold = true), p.text("Amethyst Desktop").style)
        assertEquals(Style(italic = true), p.text("more").style)
        assertEquals(Style(code = true), p.text("npm i").style)
        assertEquals(Style(strike = true), p.text("old").style)
        assertEquals(Style(bold = true), p.text("done").style)
        assertEquals(Style(italic = true), p.text("ok").style)
    }

    @Test
    fun `snake_case, lone asterisks and math stay as written`() {
        for (t in listOf("call some_long_name now", "2 * 3 * 4 = 24", "a**b", "price: 5*", "file_name_v2.txt and a__b__c")) {
            assertEquals(t, t, texts(NoteMarkdown.format(t)))
        }
    }

    @Test
    fun `nothing inside code is markdown`() {
        val p = NoteMarkdown.format("run `a **b** c` now")
        assertEquals("run a **b** c now", texts(p))
        assertEquals(Style(code = true), p.text("a **b** c").style)
    }

    @Test
    fun `headings become bold lines, bullets and rules are tidied`() {
        val p = NoteMarkdown.format("## Contributors\n- one\n* two\n---\nend")
        assertEquals("Contributors\n• one\n• two\n———\nend", texts(p))
        assertEquals(Style(bold = true), p.text("Contributors").style)
        assertEquals("#Amethyst v1.18", texts(NoteMarkdown.format("#Amethyst v1.18")))
    }

    @Test
    fun `markdown links keep their label, images that render as media drop out`() {
        val p = NoteMarkdown.format("see [the docs](https://example.com/a_b) and ![pic](https://x.test/i.png)") { it.endsWith(".png") }
        assertEquals("see [the docs] and", texts(p))
        assertEquals(Piece.Link("the docs", "https://example.com/a_b", Style()), p.first { it is Piece.Link })
    }

    @Test
    fun `emphasis can wrap a mention and plain URLs stay tokens`() {
        val npub = "npub1" + "q".repeat(58)
        val p = NoteMarkdown.format("**by nostr:$npub** at https://example.com/x_y_z")
        val mention = p.first { it is Piece.Token && it.token is ContentToken.Profile }
        assertTrue(mention.style.bold)
        val url = p.first { it is Piece.Token && it.token is ContentToken.Url } as Piece.Token
        assertEquals("https://example.com/x_y_z", (url.token as ContentToken.Url).url)
    }

    @Test
    fun `private-use characters in a note cannot pose as placeholders`() {
        assertEquals("a�b�c", texts(NoteMarkdown.format("abc")))
    }

    @Test
    fun `blank-line runs collapse and the ends are trimmed`() {
        assertEquals("hi\n\nthere", texts(NoteMarkdown.format("\n\n hi\n\n\n\nthere \n")))
    }

    @Test
    fun `long notes are over 600 characters or 12 lines`() {
        assertFalse(NoteMarkdown.isLong("x".repeat(600)))
        assertTrue(NoteMarkdown.isLong("x".repeat(601)))
        assertFalse(NoteMarkdown.isLong("a\n".repeat(11) + "a"))
        assertTrue(NoteMarkdown.isLong("a\n".repeat(12) + "a"))
    }
}
