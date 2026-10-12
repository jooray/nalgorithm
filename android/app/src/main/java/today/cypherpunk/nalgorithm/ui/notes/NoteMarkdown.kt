package today.cypherpunk.nalgorithm.ui.notes

/**
 * The light markdown people write in notes, turned into styled pieces (web markdown.ts).
 *
 * Covers **bold** / __bold__, *italic* / _italic_ (never inside snake_case
 * words), `code`, ~~strike~~, # headings (a bold line), - and * bullets (•),
 * horizontal rules and [label](https://…) links. Emphasis may wrap a mention
 * or a link. Everything else stays as written.
 */
object NoteMarkdown {
    data class Style(val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false, val strike: Boolean = false)

    sealed interface Piece {
        val style: Style
        data class Text(val text: String, override val style: Style) : Piece
        data class Token(val token: ContentToken, override val style: Style) : Piece
        data class Link(val label: String, val url: String, override val style: Style) : Piece
    }

    private const val BOLD = 1
    private const val ITALIC = 2
    private const val CODE = 4
    private const val STRIKE = 8

    // Private-use characters stand in for tokens and links while the inline pass runs.
    private const val TOKEN_BASE = 0xE000
    private const val LINK_BASE = 0xF000
    private const val MAX_PLACEHOLDERS = 0x800
    private val PRIVATE_USE = Regex("[\\uE000-\\uF8FF]")
    /** A consumed delimiter in the working copy: neither a word, a space nor a marker. */
    private const val GONE = '\u0001'
    /** Code text in the working copy, so no other pattern matches inside it. */
    private const val INERT = '\u0002'

    private val HEADING = Regex("^[ \\t]{0,3}#{1,6}[ \\t]+(.+?)[ \\t#]*$", RegexOption.MULTILINE)
    private val RULE = Regex("^[ \\t]*([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$", RegexOption.MULTILINE)
    private val BULLET = Regex("^([ \\t]*)[-*+][ \\t]+", RegexOption.MULTILINE)
    private val LINK = Regex("(!?)\\[([^\\]\\n]{1,300})\\]\\((https?://[^\\s)]+)\\)")
    private val CODE_SPAN = Regex("`([^`\\n]+)`")
    private val BLANK_RUN = Regex("\n{3,}")

    private class Inline(val pattern: Regex, val delimiter: Int, val flag: Int)

    private val INLINE = listOf(
        Inline(Regex("\\*\\*(?=[^\\s*])([^\\n]*?[^\\s*])\\*\\*"), 2, BOLD),
        Inline(Regex("(?<![\\p{L}\\p{N}_])__(?=[^\\s_])([^\\n]*?[^\\s_])__(?![\\p{L}\\p{N}_])"), 2, BOLD),
        Inline(Regex("~~(?=\\S)([^\\n]*?\\S)~~"), 2, STRIKE),
        Inline(Regex("(?<![\\p{L}\\p{N}*])\\*(?=[^\\s*])([^\\n*]*?[^\\s*])\\*(?![\\p{L}\\p{N}*])"), 1, ITALIC),
        Inline(Regex("(?<![\\p{L}\\p{N}_])_(?=[^\\s_])([^\\n_]*?[^\\s_])_(?![\\p{L}\\p{N}_])"), 1, ITALIC),
    )

    private fun styleOf(mask: Int) = Style(mask and BOLD != 0, mask and ITALIC != 0, mask and CODE != 0, mask and STRIKE != 0)

    private fun isPlaceholder(ch: Char) = ch.code in TOKEN_BASE until LINK_BASE + MAX_PLACEHOLDERS

    /** Split note text into styled pieces. [isMedia] says whether an `![alt](url)` image is shown as media elsewhere. */
    fun format(content: String, isMedia: (String) -> Boolean = { false }): List<Piece> {
        val links = ArrayList<Pair<String, String>>()
        val prepared = content
            .replace(PRIVATE_USE, "�")
            .replace(RULE, "———")
            .replace(HEADING, "**$1**")
            .replace(BULLET, "$1• ")
            .replace(LINK) { m ->
                val (bang, label, url) = m.destructured
                when {
                    bang.isNotEmpty() && isMedia(url) -> ""
                    links.size >= MAX_PLACEHOLDERS -> m.value
                    else -> {
                        links += label to url
                        (LINK_BASE + links.size - 1).toChar().toString()
                    }
                }
            }

        val others = ArrayList<ContentToken>()
        val original = StringBuilder()
        for (t in tokenizeContent(prepared)) {
            if (t is ContentToken.Text) original.append(t.text)
            else if (others.size < MAX_PLACEHOLDERS) {
                others += t
                original.append((TOKEN_BASE + others.size - 1).toChar())
            }
        }

        val units = original.toString()
        val work = units.toCharArray()
        val removed = BooleanArray(units.length)
        val mask = IntArray(units.length)

        // Code first: nothing inside it is markdown.
        for (m in CODE_SPAN.findAll(units)) {
            val at = m.range.first
            val end = m.range.last + 1
            removed[at] = true; removed[end - 1] = true
            work[at] = GONE; work[end - 1] = GONE
            for (i in at + 1 until end - 1) {
                mask[i] = mask[i] or CODE
                if (!isPlaceholder(units[i])) work[i] = INERT
            }
        }

        for (rule in INLINE) {
            val current = String(work)
            for (m in rule.pattern.findAll(current)) {
                val at = m.range.first
                val end = m.range.last + 1
                for (i in 0 until rule.delimiter) {
                    removed[at + i] = true; removed[end - 1 - i] = true
                    work[at + i] = GONE; work[end - 1 - i] = GONE
                }
                for (i in at + rule.delimiter until end - rule.delimiter) mask[i] = mask[i] or rule.flag
            }
        }

        val pieces = ArrayList<Piece>()
        val text = StringBuilder()
        var textMask = -1
        fun flush() {
            if (text.isNotEmpty()) pieces += Piece.Text(text.toString(), styleOf(textMask))
            text.clear()
        }
        for (i in units.indices) {
            if (removed[i]) continue
            val code = units[i].code
            when {
                code >= LINK_BASE && code < LINK_BASE + links.size -> {
                    flush()
                    val (label, url) = links[code - LINK_BASE]
                    pieces += Piece.Link(label, url, styleOf(mask[i]))
                }
                code >= TOKEN_BASE && code < TOKEN_BASE + others.size -> {
                    flush()
                    pieces += Piece.Token(others[code - TOKEN_BASE], styleOf(mask[i]))
                }
                else -> {
                    if (mask[i] != textMask) flush()
                    textMask = mask[i]
                    text.append(units[i])
                }
            }
        }
        flush()

        // Blank-line runs collapse, and the note starts and ends with something to read.
        for (i in pieces.indices) {
            val p = pieces[i]
            if (p is Piece.Text) {
                var t = p.text.replace(BLANK_RUN, "\n\n")
                if (i == 0) t = t.trimStart()
                if (i == pieces.lastIndex) t = t.trimEnd()
                pieces[i] = p.copy(text = t)
            }
        }
        return pieces.filter { it !is Piece.Text || it.text.isNotEmpty() }
    }

    /** A note long enough that a feed card shows it shortened, with Read more. */
    fun isLong(content: String): Boolean {
        if (content.length > 600) return true
        var lines = 1
        for (ch in content) if (ch == '\n' && ++lines > 12) return true
        return false
    }
}
