package today.cypherpunk.nalgorithm.engine

import java.net.URI

/**
 * Relay URLs taken from other people's events are attacker-controlled input
 * (lib relay-url.ts). Only public wss:// hosts pass.
 */
object RelayUrl {
    private const val MAX_URL_LENGTH = 200

    private fun ipv4Private(a: Int, b: Int): Boolean =
        a == 0 || a == 10 || a == 127 || a >= 224 ||
            (a == 100 && b in 64..127) ||
            (a == 169 && b == 254) ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168)

    internal fun hostIsPrivate(hostname: String): Boolean {
        val host = hostname.removePrefix("[").removeSuffix("]").lowercase()
        val family = if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) 4 else if (host.contains(':')) 6 else 0
        if (family == 4) {
            val (a, b) = host.split('.').map { it.toInt() }
            return ipv4Private(a, b)
        }
        if (family == 6) {
            val full = expandIpv6(host) ?: return true
            if (full.all { it == 0 } || (full.take(7).all { it == 0 } && full[7] == 1)) return true
            // v4-mapped (::ffff:a.b.c.d)
            if (full.take(5).all { it == 0 } && full[5] == 0xffff) return ipv4Private(full[6] shr 8, full[6] and 255)
            val first = full[0]
            return (first and 0xfe00) == 0xfc00 || (first and 0xffc0) == 0xfe80 || (first and 0xff00) == 0xff00
        }
        return host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
            host.endsWith(".internal") || host.endsWith(".lan") || !host.contains('.')
    }

    /** Eight 16-bit groups, or null when it is not an IPv6 literal. */
    private fun expandIpv6(host: String): IntArray? {
        var h = host.substringBefore('%')
        // A dotted IPv4 tail becomes two groups.
        val v4 = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").find(h)
        if (v4 != null) {
            val p = v4.groupValues.drop(1).map { it.toInt() }
            if (p.any { it > 255 }) return null
            h = h.substring(0, v4.range.first) + "%x:%x".format((p[0] shl 8) or p[1], (p[2] shl 8) or p[3])
        }
        val parts = h.split("::")
        if (parts.size > 2) return null
        fun groups(s: String) = if (s.isEmpty()) emptyList() else s.split(':')
        val head = groups(parts[0])
        val tail = if (parts.size == 2) groups(parts[1]) else emptyList()
        val missing = 8 - head.size - tail.size
        if (parts.size == 1 && head.size != 8) return null
        if (parts.size == 2 && missing < 1) return null
        val all = head + List(if (parts.size == 2) missing else 0) { "0" } + tail
        return try {
            all.map { g -> require(g.length in 1..4); g.toInt(16) }.toIntArray()
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Normalise a relay URL taken from someone else's event, or null if we must not connect to it.
     * [allowInsecure] exists for tests that talk to a relay on 127.0.0.1.
     */
    fun sanitize(url: String?, allowInsecure: Boolean = false): String? {
        if (url == null || url.length > MAX_URL_LENGTH) return null
        val u = try {
            URI(url.trim())
        } catch (_: Exception) {
            return null
        }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "wss" && !(allowInsecure && scheme == "ws")) return null
        val host = u.host ?: return null
        if (!allowInsecure && (u.rawUserInfo != null || hostIsPrivate(host))) return null
        val port = if (u.port == -1 || (u.port == 443 && scheme == "wss") || (u.port == 80 && scheme == "ws")) "" else ":${u.port}"
        val path = u.rawPath.orEmpty().ifEmpty { "/" }
        val query = u.rawQuery?.let { "?$it" } ?: ""
        val text = "$scheme://${host.lowercase()}$port$path$query"
        return if (path == "/" && query.isEmpty()) text.dropLast(1) else text
    }

    fun isAcceptable(url: String?, allowInsecure: Boolean = false): Boolean = sanitize(url, allowInsecure) != null
}
