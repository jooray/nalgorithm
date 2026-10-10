package today.cypherpunk.nalgorithm.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The few JavaScript behaviours the library's output depends on: JSON.stringify
 * (fingerprints must hash the same bytes as the web app), number printing in
 * prompts ("8", not "8.0") and parseInt. Kept in one place so they stay exact.
 */
internal object Js {
    /** Strict like JSON.parse: no comments, no unquoted keys, no trailing commas. */
    val strictJson: Json = Json { isLenient = false; ignoreUnknownKeys = true }

    /** JSON.parse, or null when the text is not JSON. */
    fun parse(text: String): JsonElement? = try {
        strictJson.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }

    /** JSON.stringify of a string, including its quotes. */
    fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    sb.append(c).append(s[i + 1]); i++
                }
                // Well-formed JSON.stringify (ES2019) escapes lone surrogates.
                c.isSurrogate() -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
        return sb.toString()
    }

    /** How JavaScript prints a number: integers without a fraction. */
    fun number(d: Double): String = when {
        d.isNaN() -> "NaN"
        d.isInfinite() -> if (d > 0) "Infinity" else "-Infinity"
        d == Math.rint(d) && kotlin.math.abs(d) < 1e21 -> d.toLong().toString()
        else -> d.toString()
    }

    /** JSON.stringify of a parsed value. */
    fun stringify(e: JsonElement): String = when (e) {
        is JsonNull -> "null"
        is JsonPrimitive -> when {
            e.isString -> quote(e.content)
            e.booleanOrNull != null -> e.content
            else -> e.doubleOrNull?.let { number(it) } ?: e.content
        }
        is JsonArray -> e.joinToString(",", "[", "]") { stringify(it) }
        is JsonObject -> e.entries.joinToString(",", "{", "}") { (k, v) -> quote(k) + ":" + stringify(v) }
    }

    /** parseInt(value, 10): leading whitespace, a sign, digits; anything after is ignored. */
    fun parseInt(value: String): Long? {
        val m = Regex("^[\\s\\uFEFF\\u00A0]*([+-]?\\d+)").find(value) ?: return null
        return m.groupValues[1].toBigInteger().let { if (it.bitLength() < 63) it.toLong() else null }
    }

    /** Math.round: halves go up. */
    fun round(d: Double): Long = Math.floor(d + 0.5).toLong()

    /** JavaScript's \s, for the regexes that split speech and prompts. */
    const val WS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
}
