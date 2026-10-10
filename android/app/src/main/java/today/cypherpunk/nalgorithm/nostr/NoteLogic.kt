package today.cypherpunk.nalgorithm.nostr

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.math.BigInteger
import java.net.URI
import java.net.URLEncoder
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/**
 * Note actions, pure logic (web: note-logic.ts). Everything that decides what
 * an event looks like, or whether an answer from a stranger's server can be
 * trusted, with no UI and no network:
 *
 *  - NIP-10 reply tags, NIP-25 reactions, NIP-18 reposts
 *  - NIP-65 relay lists and where an event is published
 *  - NIP-57 zaps: zap request, LNURL-pay parameters, bolt11 amount and
 *    description hash, and the receipt
 *
 * Rule for zaps: every field that comes from an LNURL server or from a relay
 * is untrusted input and is checked before it reaches the screen or a wallet.
 */
object NoteLogic {
    /** An event before it has an author: what a signer is asked to sign. */
    data class Template(val kind: Int, val createdAt: Long, val content: String, val tags: List<List<String>>) {
        fun withAuthor(pubkey: String) = UnsignedEvent(pubkey, createdAt, kind, tags, content)
    }

    /** What an action needs to know about the note it targets. */
    data class Target(val id: String, val author: String, val kind: Int = 1, val relay: String? = null)

    fun isHex64(value: String?): Boolean = Hex.isHex64(value)

    // ─── Relays (NIP-65) ─────────────────────────────────────────────────────

    /** A clean wss:// URL, or "" when the input cannot be used. ws:// is kept only for localhost. */
    fun normalizeRelay(input: String): String {
        val raw = input.trim()
        if (raw.isEmpty() || raw.length > 200) return ""
        return try {
            val url = URI(raw)
            val scheme = url.scheme?.lowercase() ?: return ""
            val host = url.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return ""
            val local = host == "localhost" || host == "127.0.0.1"
            if (scheme != "wss" && !(scheme == "ws" && local)) return ""
            if (url.rawUserInfo != null) return ""
            val defaultPort = if (scheme == "wss") 443 else 80
            val port = if (url.port == -1 || url.port == defaultPort) "" else ":${url.port}"
            val rawPath = url.rawPath.orEmpty()
            val path = if (rawPath == "/" || rawPath.isEmpty()) "" else rawPath.trimEnd('/')
            val search = url.rawQuery?.let { "?$it" }.orEmpty()
            "$scheme://$host$port$path$search"
        } catch (e: Exception) {
            ""
        }
    }

    data class RelayList(val read: List<String>, val write: List<String>)

    /** Read and write relays from a kind 10002 event. An `r` tag without a marker is both. */
    fun parseRelayList(tags: List<List<String>>): RelayList {
        val read = LinkedHashSet<String>()
        val write = LinkedHashSet<String>()
        for (tag in tags) {
            if (tag.getOrNull(0) != "r") continue
            val url = normalizeRelay(tag.getOrNull(1) ?: continue)
            if (url.isEmpty()) continue
            when (tag.getOrNull(2)) {
                "read" -> read.add(url)
                "write" -> write.add(url)
                else -> {
                    read.add(url); write.add(url)
                }
            }
        }
        return RelayList(read.toList(), write.toList())
    }

    private const val MAX_OWN_RELAYS = 8
    private const val MAX_PARENT_RELAYS = 3

    /**
     * Where to publish: the writer's own write relays (or the configured defaults
     * when their list is unknown), plus a few of the parent author's read relays
     * so the reply reaches them.
     */
    fun selectPublishRelays(ownWrite: List<String>?, defaults: List<String>, parentRead: List<String>?): List<String> {
        fun clean(list: List<String>?) = (list ?: emptyList()).map(::normalizeRelay).filter { it.isNotEmpty() }.distinct()
        var own = clean(ownWrite)
        if (own.isEmpty()) own = clean(defaults)
        val out = own.take(MAX_OWN_RELAYS).toMutableList()
        for (r in clean(parentRead).take(MAX_PARENT_RELAYS)) if (r !in out) out.add(r)
        return out
    }

    /** "Published to 3 of 5 relays", honest about zero and about partial success. */
    fun describePublish(results: List<RelayResult>): String {
        val total = results.size
        val ok = results.count { it.ok }
        if (total == 0) return "No relays to publish to"
        if (ok == 0) return "No relay accepted it (0 of $total)"
        return "Published to $ok of $total ${if (total == 1) "relay" else "relays"}"
    }

    // ─── Templates: like, boost, reply ───────────────────────────────────────

    /** NIP-25 reaction: kind 7, content "+". */
    fun likeTemplate(target: Target, created: Long = nowSeconds()): Template {
        val tags = listOf(
            listOf("e", target.id, target.relay ?: "", target.author),
            listOf("p", target.author, ""),
            listOf("k", target.kind.toString()),
        )
        return Template(7, created, "+", tags)
    }

    /**
     * NIP-18 repost. A kind 1 note is boosted with kind 6, anything else with the
     * generic repost, kind 16, which also carries a `k` tag. The content is the
     * JSON of the original when we have it and empty when we do not (allowed).
     */
    fun repostTemplate(target: Target, original: NostrEvent?, created: Long = nowSeconds()): Template {
        val isNote = target.kind == 1
        val tags = mutableListOf(listOf("e", target.id, target.relay ?: ""), listOf("p", target.author))
        if (!isNote) tags.add(listOf("k", target.kind.toString()))
        val content = if (original != null && original.id == target.id) original.toJsonString() else ""
        return Template(if (isNote) 6 else 16, created, content, tags)
    }

    /** nostr-tools nip10 EventPointer. [relays] is shared with author hints, as there. */
    class EventPointer(val id: String, var relays: MutableList<String>, val author: String?)

    class ProfilePointer(val pubkey: String, var relays: MutableList<String>)

    class Nip10Refs(
        val root: EventPointer?,
        val reply: EventPointer?,
        val mentions: List<EventPointer>,
        val profiles: List<ProfilePointer>,
    )

    /** A port of nostr-tools' nip10.parse: marked tags first, positional (deprecated) ones as the fallback. */
    fun nip10Parse(tags: List<List<String>>): Nip10Refs {
        var root: EventPointer? = null
        var reply: EventPointer? = null
        val mentions = mutableListOf<EventPointer>()
        val profiles = mutableListOf<ProfilePointer>()
        var maybeParent: EventPointer? = null
        var maybeRoot: EventPointer? = null
        for (i in tags.indices.reversed()) {
            val tag = tags[i]
            val name = tag.getOrNull(0)
            val value = tag.getOrNull(1)
            if (name == "e" && !value.isNullOrEmpty()) {
                val relay = tag.getOrNull(2)
                val pointer = EventPointer(value, if (!relay.isNullOrEmpty()) mutableListOf(relay) else mutableListOf(), tag.getOrNull(4))
                when (tag.getOrNull(3)) {
                    "root" -> root = pointer
                    "reply" -> reply = pointer
                    "mention" -> mentions.add(pointer)
                    else -> {
                        if (maybeParent == null) maybeParent = pointer else maybeRoot = pointer
                        mentions.add(pointer)
                    }
                }
                continue
            }
            if (name == "p" && !value.isNullOrEmpty()) {
                val relay = tag.getOrNull(2)
                profiles.add(ProfilePointer(value, if (!relay.isNullOrEmpty()) mutableListOf(relay) else mutableListOf()))
            }
        }
        if (root == null) root = maybeRoot ?: maybeParent ?: reply
        if (reply == null) reply = maybeParent ?: root
        fun inherit(ref: EventPointer) {
            val author = ref.author ?: return
            val profile = profiles.firstOrNull { it.pubkey == author } ?: return
            for (url in profile.relays) if (url !in ref.relays) ref.relays.add(url)
            profile.relays = ref.relays
        }
        for (ref in listOfNotNull(reply, root)) {
            mentions.remove(ref)
            inherit(ref)
        }
        mentions.forEach(::inherit)
        return Nip10Refs(root, reply, mentions, profiles)
    }

    data class Parent(val id: String, val relay: String?, val author: String?)

    /** The direct parent of an event per NIP-10 (marked or positional), or null for a top-level note. */
    fun parentOf(tags: List<List<String>>): Parent? {
        val refs = nip10Parse(tags)
        val ref = refs.reply ?: refs.root ?: return null
        if (!isHex64(ref.id)) return null
        return Parent(ref.id, ref.relays.firstOrNull(), ref.author)
    }

    private const val MAX_P_TAGS = 20

    /**
     * Tags for a reply to the parent, per NIP-10 with markers.
     *
     *  - Parent is top-level: one `e` tag, marked root.
     *  - Parent is itself a reply: the parent's root, marked root, then the parent,
     *    marked reply.
     *  - `p` tags: the parent's author first, then everyone the parent tagged,
     *    deduplicated, never yourself, at most 20.
     */
    fun replyTags(parentId: String, parentPubkey: String, parentTags: List<List<String>>, relay: String? = null, self: String? = null): List<List<String>> {
        val refs = nip10Parse(parentTags)
        val r = relay ?: ""
        val tags = mutableListOf<List<String>>()
        val root = refs.root?.takeIf { isHex64(it.id) }
        if (root != null && root.id != parentId) {
            val rootRelay = root.relays.firstOrNull() ?: ""
            tags.add(if (root.author != null) listOf("e", root.id, rootRelay, "root", root.author) else listOf("e", root.id, rootRelay, "root"))
            tags.add(listOf("e", parentId, r, "reply", parentPubkey))
        } else {
            tags.add(listOf("e", parentId, r, "root", parentPubkey))
        }
        val people = mutableListOf(parentPubkey)
        for (tag in parentTags) if (tag.getOrNull(0) == "p" && isHex64(tag.getOrNull(1))) people.add(tag[1])
        val seen = LinkedHashSet<String>()
        for (pk in people) {
            if (pk in seen || pk == self) continue
            seen.add(pk)
            if (seen.size > MAX_P_TAGS) break
            tags.add(listOf("p", pk))
        }
        return tags
    }

    fun replyTemplate(
        content: String,
        parentId: String,
        parentPubkey: String,
        parentTags: List<List<String>>,
        relay: String? = null,
        self: String? = null,
        created: Long = nowSeconds(),
    ): Template = Template(1, created, content.trim(), replyTags(parentId, parentPubkey, parentTags, relay, self))

    /** Direct replies to [targetId], oldest first, at most [limit]. Events that only mention it are dropped. */
    fun directReplies(events: List<NostrEvent>, targetId: String, limit: Int = 20): List<NostrEvent> {
        val seen = HashSet<String>()
        val out = mutableListOf<NostrEvent>()
        for (e in events) {
            if (e.kind != 1 || !seen.add(e.id)) continue
            if (parentOf(e.tags)?.id == targetId) out.add(e)
        }
        return out.sortedWith(compareBy<NostrEvent> { it.createdAt }.thenBy { it.id }).take(limit)
    }

    // ─── bech32 (lnurl and bolt11) ───────────────────────────────────────────

    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    private val GEN = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)

    private fun polymod(values: List<Int>): Int {
        var chk = 1
        for (v in values) {
            val top = chk ushr 25
            chk = ((chk and 0x1ffffff) shl 5) xor v
            for (i in 0 until 5) if ((top ushr i) and 1 == 1) chk = chk xor GEN[i]
        }
        return chk
    }

    private fun hrpExpand(hrp: String): List<Int> =
        hrp.map { it.code ushr 5 } + 0 + hrp.map { it.code and 31 }

    data class Bech32Words(val hrp: String, val words: List<Int>)

    /** Decode a bech32 string (not bech32m) of any length. Null if malformed or the checksum fails. */
    fun bech32Decode(input: String): Bech32Words? {
        if (input != input.lowercase() && input != input.uppercase()) return null
        val s = input.lowercase()
        val sep = s.lastIndexOf('1')
        if (sep < 1 || sep + 7 > s.length) return null
        val hrp = s.substring(0, sep)
        val data = ArrayList<Int>(s.length - sep)
        for (ch in s.substring(sep + 1)) {
            val v = CHARSET.indexOf(ch)
            if (v < 0) return null
            data.add(v)
        }
        if (polymod(hrpExpand(hrp) + data) != 1) return null
        return Bech32Words(hrp, data.dropLast(6))
    }

    internal fun convertBits(data: List<Int>, from: Int, to: Int, pad: Boolean): List<Int>? {
        var acc = 0
        var bits = 0
        val out = ArrayList<Int>()
        val max = (1 shl to) - 1
        for (v in data) {
            if (v < 0 || (v shr from) != 0) return null
            acc = (acc shl from) or v
            bits += from
            while (bits >= to) {
                bits -= to
                out.add((acc shr bits) and max)
            }
            acc = acc and ((1 shl bits) - 1)
        }
        if (pad) {
            if (bits > 0) out.add((acc shl (to - bits)) and max)
        } else if (bits >= from || ((acc shl (to - bits)) and max) != 0) {
            return null
        }
        return out
    }

    fun bech32Encode(hrp: String, bytes: ByteArray): String =
        bech32EncodeWords(hrp, convertBits(bytes.map { it.toInt() and 0xff }, 8, 5, true) ?: emptyList())

    fun bech32EncodeWords(hrp: String, words: List<Int>): String {
        val check = polymod(hrpExpand(hrp) + words + listOf(0, 0, 0, 0, 0, 0)) xor 1
        val checksum = (0 until 6).map { (check ushr (5 * (5 - it))) and 31 }
        return hrp + "1" + (words + checksum).joinToString("") { CHARSET[it].toString() }
    }

    // ─── LNURL (LUD-01, LUD-06, LUD-16) ──────────────────────────────────────

    /** The bech32 `lnurl1…` form of a URL (what the zap request's `lnurl` tag carries). */
    fun lnurlEncode(url: String): String = bech32Encode("lnurl", url.toByteArray(Charsets.UTF_8))

    /** The URL inside an `lnurl1…` string, or null. Only https is accepted. */
    fun lnurlDecode(lnurl: String): String? {
        val dec = bech32Decode(lnurl.trim().replace(LIGHTNING_PREFIX, "")) ?: return null
        if (dec.hrp != "lnurl") return null
        val bytes = convertBits(dec.words, 5, 8, false) ?: return null
        val url = strictUtf8(ByteArray(bytes.size) { bytes[it].toByte() }) ?: return null
        return if (isHttpsUrl(url)) url else null
    }

    private val LIGHTNING_PREFIX = Regex("^lightning:", RegexOption.IGNORE_CASE)

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        null
    }

    fun isHttpsUrl(value: String?): Boolean {
        if (value == null || value.length > 2048) return false
        val url = value.toHttpUrlOrNull() ?: return false
        if (!value.trim().startsWith("https:", ignoreCase = true)) return false
        return url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.host.contains('.')
    }

    private val LN_ADDRESS = Regex("^([a-z0-9._+-]{1,64})@((?:[a-z0-9-]+\\.)+[a-z]{2,})$", RegexOption.IGNORE_CASE)

    /** A well-formed Lightning address, lower-cased, or null. */
    fun parseLightningAddress(input: String): String? {
        val s = input.trim().replace(LIGHTNING_PREFIX, "")
        return if (LN_ADDRESS.matches(s)) s.lowercase() else null
    }

    /** The LNURL-pay endpoint of a Lightning address. */
    fun lightningAddressUrl(address: String): String? {
        val parsed = parseLightningAddress(address) ?: return null
        val (name, domain) = parsed.split('@')
        return "https://$domain/.well-known/lnurlp/${encodeURIComponent(name)}"
    }

    /** JavaScript's encodeURIComponent. */
    internal fun encodeURIComponent(s: String): String =
        URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'")
            .replace("%28", "(").replace("%29", ")").replace("%7E", "~")

    data class PayTarget(
        /** Shown to the reader. */
        val label: String,
        /** The LNURL-pay endpoint. */
        val url: String,
        /** The bech32 form for the zap request. */
        val lnurl: String,
        /** The address to copy as a fallback, when there is one. */
        val address: String? = null,
    )

    /** Where to pay an author, from their kind 0 metadata: lud16 first, then lud06. Null when neither is usable. */
    fun payTargetFromProfile(meta: JsonObject): PayTarget? {
        val lud16 = (meta["lud16"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val lud06 = (meta["lud06"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return payTarget(lud16, lud06)
    }

    fun payTarget(lud16: String?, lud06: String?): PayTarget? {
        if (lud16 != null) {
            val address = parseLightningAddress(lud16)
            val url = address?.let(::lightningAddressUrl)
            if (address != null && url != null) return PayTarget(address, url, lnurlEncode(url), address)
        }
        if (lud06 != null) {
            val url = lnurlDecode(lud06)
            if (url != null) {
                val host = url.toHttpUrlOrNull()?.host ?: return null
                return PayTarget(host, url, lud06.trim().replace(LIGHTNING_PREFIX, "").lowercase())
            }
        }
        return null
    }

    data class PayParams(
        val callback: String,
        val minSendable: Double,
        val maxSendable: Double,
        val commentAllowed: Int,
        val nostrPubkey: String,
    )

    sealed interface Checked<out T> {
        data class Ok<T>(val value: T) : Checked<T>
        data class Fail(val error: String) : Checked<Nothing>
    }

    /** JavaScript's Number(x) for a JSON value. */
    private fun jsNumber(e: JsonElement?): Double = when {
        e == null -> Double.NaN
        e is JsonNull -> 0.0
        e is JsonPrimitive && e.isString -> e.content.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: Double.NaN }
        e is JsonPrimitive -> e.booleanOrNull?.let { if (it) 1.0 else 0.0 } ?: e.doubleOrNull ?: Double.NaN
        else -> Double.NaN
    }

    /**
     * Validate an LNURL-pay response for a zap. Untrusted input: the callback must
     * be https, the sendable range must be sane, and the server must declare
     * `allowsNostr` with a valid `nostrPubkey`, otherwise no receipt can ever be
     * verified and the payment would not be a zap.
     */
    fun parsePayParams(json: JsonElement?): Checked<PayParams> {
        val j = json as? JsonObject ?: return Checked.Fail("The Lightning server sent something unexpected.")
        fun str(k: String) = (j[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        if (str("status") == "ERROR") return Checked.Fail("The Lightning server refused the request.")
        if (str("tag") != "payRequest") return Checked.Fail("That address is not a Lightning payment endpoint.")
        val callback = str("callback")
        if (!isHttpsUrl(callback)) return Checked.Fail("The server gave an unsafe payment callback (not https), so I did not use it.")
        val min = jsNumber(j["minSendable"])
        val max = jsNumber(j["maxSendable"])
        if (!min.isFinite() || !max.isFinite() || min < 1 || max < min) return Checked.Fail("The server gave an invalid amount range.")
        val allows = (j["allowsNostr"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        if (allows != true) return Checked.Fail("That Lightning address does not support zaps (it does not declare Nostr support).")
        val nostrPubkey = str("nostrPubkey")
        if (!isHex64(nostrPubkey)) return Checked.Fail("The server did not give a valid key for zap receipts, so a zap cannot be verified.")
        val comment = jsNumber(j["commentAllowed"])
        return Checked.Ok(
            PayParams(
                callback = callback!!,
                minSendable = min,
                maxSendable = max,
                commentAllowed = if (comment.isFinite() && comment > 0) kotlin.math.floor(comment).coerceAtMost(Int.MAX_VALUE.toDouble()).toInt() else 0,
                nostrPubkey = nostrPubkey!!,
            ),
        )
    }

    private val EN = DecimalFormat("#,##0.###", DecimalFormatSymbols(Locale.US))

    /** Number.toLocaleString('en'). */
    fun formatEn(n: Double): String = EN.format(n)

    fun formatEn(n: Long): String = EN.format(n)

    /** Check an amount (in sats) against the server's range; the value is in millisats. */
    fun checkAmount(minSendable: Double, maxSendable: Double, sats: Double): Checked<Long> {
        if (!sats.isFinite() || sats != kotlin.math.floor(sats) || sats < 1) return Checked.Fail("Enter a whole number of sats.")
        val msats = sats * 1000
        val minSats = kotlin.math.ceil(minSendable / 1000)
        val maxSats = kotlin.math.floor(maxSendable / 1000)
        if (msats < minSendable) return Checked.Fail("The smallest zap this address accepts is ${formatEn(minSats)} sats.")
        if (msats > maxSendable) return Checked.Fail("The largest zap this address accepts is ${formatEn(maxSats)} sats.")
        return Checked.Ok(msats.toLong())
    }

    /** The callback request URL: amount, the signed zap request and the lnurl, plus the comment when the server allows one. */
    fun buildInvoiceUrl(callback: String, commentAllowed: Int, msats: Long, zapRequestJson: String, lnurl: String, comment: String?): String {
        val b = callback.toHttpUrlOrNull()!!.newBuilder()
        b.setQueryParameter("amount", msats.toString())
        b.setQueryParameter("nostr", zapRequestJson)
        b.setQueryParameter("lnurl", lnurl)
        val c = (comment ?: "").trim()
        if (c.isNotEmpty() && commentAllowed > 0) b.setQueryParameter("comment", c.take(commentAllowed))
        return b.build().toString()
    }

    // ─── Zap request (kind 9734) ─────────────────────────────────────────────

    /** The unsigned NIP-57 zap request. It is sent to the LNURL server, never published to a relay. */
    fun zapRequestTemplate(
        recipient: String,
        eventId: String?,
        eventKind: Int?,
        msats: Long,
        relays: List<String>,
        lnurl: String,
        comment: String? = null,
        created: Long = nowSeconds(),
    ): Template {
        val tags = mutableListOf(
            listOf("relays") + relays,
            listOf("amount", msats.toString()),
            listOf("lnurl", lnurl),
            listOf("p", recipient),
        )
        if (eventId != null) tags.add(listOf("e", eventId))
        if (eventId != null && eventKind != null) tags.add(listOf("k", eventKind.toString()))
        return Template(9734, created, (comment ?: "").trim(), tags)
    }

    // ─── bolt11 ──────────────────────────────────────────────────────────────

    private val BOLT11_HRP = Regex("^ln(?:bcrt|bc|tbs|tb)(\\d*)([munp]?)$")

    /** The amount of a bolt11 invoice in millisatoshis, or null when it has none or is malformed. */
    fun parseBolt11Amount(invoice: String): BigInteger? {
        val s = invoice.trim().lowercase().replace(Regex("^lightning:"), "")
        val sep = s.lastIndexOf('1')
        if (sep < 4) return null
        val m = BOLT11_HRP.find(s.substring(0, sep)) ?: return null
        val digits = m.groupValues[1]
        val unit = m.groupValues[2]
        if (digits.isEmpty()) return null
        if (digits.length > 1 && digits.startsWith("0")) return null
        val n = BigInteger(digits)
        val divisor = when (unit) {
            "" -> BigInteger.ONE
            "m" -> BigInteger.valueOf(1000)
            "u" -> BigInteger.valueOf(1_000_000)
            "n" -> BigInteger.valueOf(1_000_000_000)
            else -> BigInteger.valueOf(1_000_000_000_000)
        }
        // 1 BTC = 100,000,000,000 msat
        val scaled = n.multiply(BigInteger.valueOf(100_000_000_000))
        if (unit == "p" && n.mod(BigInteger.TEN).signum() != 0) return null // sub-millisatoshi
        return scaled.divide(divisor)
    }

    data class DecodedInvoice(
        val amountMsats: BigInteger?,
        /** Hex of the `h` tag (description hash), when present. */
        val descriptionHash: String? = null,
        /** The `d` tag text, when present. */
        val description: String? = null,
        /** Unix seconds the invoice was made. */
        val timestamp: Long,
        /** Seconds it is valid for (3600 when not stated). */
        val expiry: Long = 3600,
    )

    private fun wordsToBytes(words: List<Int>): ByteArray {
        val b = convertBits(words, 5, 8, false) ?: convertBits(words, 5, 8, true) ?: emptyList()
        return ByteArray(b.size) { b[it].toByte() }
    }

    /** Decode the parts of a bolt11 invoice a zap needs. Null if it is not a valid invoice (checksum included). */
    fun decodeBolt11(invoice: String): DecodedInvoice? {
        val s = invoice.trim().lowercase().replace(Regex("^lightning:"), "")
        val dec = bech32Decode(s) ?: return null
        if (!Regex("^ln(?:bcrt|bc|tbs|tb)").containsMatchIn(dec.hrp)) return null
        val amountMsats = parseBolt11Amount(s)
        val words = dec.words
        // timestamp (7 words) ... tagged fields ... signature (104 words)
        if (words.size < 7 + 104) return null
        var timestamp = 0L
        for (w in words.subList(0, 7)) timestamp = timestamp * 32 + w
        val fields = words.subList(7, words.size - 104)
        var descriptionHash: String? = null
        var description: String? = null
        var expiry = 3600L
        var i = 0
        while (i + 3 <= fields.size) {
            val type = fields[i]
            val len = fields[i + 1] * 32 + fields[i + 2]
            if (i + 3 + len > fields.size) return null
            val data = fields.subList(i + 3, i + 3 + len)
            i += 3 + len
            when {
                type == 23 && len == 52 -> descriptionHash = Hex.encode(wordsToBytes(data).copyOf(32))
                type == 13 -> description = strictUtf8(wordsToBytes(data))
                type == 6 -> {
                    var e = 0L
                    for (w in data) e = e * 32 + w
                    expiry = e
                }
            }
        }
        return DecodedInvoice(amountMsats, descriptionHash, description, timestamp, expiry)
    }

    /**
     * Check the invoice the LNURL server returned against the zap request we
     * signed: the amount is exactly what was asked, and the invoice commits to our
     * zap request by its description hash (an `h` tag, or a `d` tag we can hash).
     */
    fun validateInvoice(invoice: JsonElement?, msats: Long, zapRequestJson: String): Checked<DecodedInvoice> {
        val text = (invoice as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (text == null || text.length > 4000) return Checked.Fail("The server did not return an invoice.")
        val decoded = decodeBolt11(text) ?: return Checked.Fail("The invoice from the server is not a valid Lightning invoice.")
        val amount = decoded.amountMsats ?: return Checked.Fail("The invoice has no amount, so I did not use it.")
        if (amount != BigInteger.valueOf(msats)) {
            val asked = msats / 1000.0
            val got = amount.toDouble() / 1000
            return Checked.Fail("The invoice is for ${formatEn(got)} sats, not the ${formatEn(asked)} you chose, so I did not use it.")
        }
        val want = sha256Hex(zapRequestJson)
        val have = decoded.descriptionHash ?: decoded.description?.let(::sha256Hex)
            ?: return Checked.Fail("The invoice does not commit to the zap request, so it would not produce a zap receipt.")
        if (have != want) return Checked.Fail("The invoice does not match the zap request I signed, so I did not use it.")
        return Checked.Ok(decoded)
    }

    // ─── Zap receipt (kind 9735) ─────────────────────────────────────────────

    /**
     * Is this event the receipt for our zap? Checks, in order: kind, that it was
     * signed by the server's declared `nostrPubkey`, that its `bolt11` is the
     * invoice we were handed (so amount matches too), that its `description` is
     * our zap request, and that the invoice's description hash is the hash of it.
     * Signature validity is checked by the caller (the relay pool drops bad ones).
     */
    fun validateReceipt(receipt: NostrEvent, zapRequest: NostrEvent, zapRequestJson: String, nostrPubkey: String, invoice: String): Checked<Long> {
        if (receipt.kind != 9735) return Checked.Fail("Not a zap receipt.")
        if (receipt.pubkey != nostrPubkey) return Checked.Fail("The receipt is not signed by the Lightning server that issued the invoice.")
        fun tag(name: String) = receipt.tags.firstOrNull { it.getOrNull(0) == name }?.getOrNull(1)
        val bolt11 = tag("bolt11")
        if (bolt11 == null || bolt11.lowercase() != invoice.trim().lowercase()) return Checked.Fail("The receipt is for a different invoice.")
        val description = tag("description")
        if (description.isNullOrEmpty()) return Checked.Fail("The receipt has no description.")
        val embedded = runCatching { relayJson.parseToJsonElement(description).jsonObject }.getOrNull()
            ?: return Checked.Fail("The receipt description is not a zap request.")
        val embeddedId = (embedded["id"] as? JsonPrimitive)?.contentOrNull
        val embeddedPubkey = (embedded["pubkey"] as? JsonPrimitive)?.contentOrNull
        if (embeddedId != zapRequest.id || embeddedPubkey != zapRequest.pubkey) return Checked.Fail("The receipt is for a different zap request.")
        if (description != zapRequestJson && embedded.toString() != zapRequestJson) {
            return Checked.Fail("The receipt description does not match the zap request.")
        }
        val decoded = decodeBolt11(bolt11)
        val amount = decoded?.amountMsats ?: return Checked.Fail("The receipt invoice is not valid.")
        val requested = zapRequest.tags.firstOrNull { it.getOrNull(0) == "amount" }?.getOrNull(1)?.toLongOrNull()
        if (requested == null || amount != BigInteger.valueOf(requested)) return Checked.Fail("The receipt amount is not what was requested.")
        val hash = decoded.descriptionHash ?: decoded.description?.let(::sha256Hex)
        if (hash != sha256Hex(description) && hash != sha256Hex(zapRequestJson)) {
            return Checked.Fail("The receipt invoice does not commit to the zap request.")
        }
        return Checked.Ok(requested)
    }

    // ─── Local note state (liked, boosted, zapped) ───────────────────────────

    data class NoteState(
        val liked: Map<String, Long> = emptyMap(),
        val boosted: Map<String, Long> = emptyMap(),
        /** Sats zapped, per note id. */
        val zapped: Map<String, Long> = emptyMap(),
    )

    const val STATE_LIMIT = 3000

    /** Parse what was stored, dropping anything that is not the expected shape. */
    fun parseNoteState(raw: String?): NoteState {
        if (raw == null) return NoteState()
        val parsed = runCatching { relayJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return NoteState()
        fun read(key: String): Map<String, Long> {
            val src = parsed[key] as? JsonObject ?: return emptyMap()
            val out = LinkedHashMap<String, Long>()
            for ((id, value) in src) {
                val n = (value as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: continue
                if (isHex64(id) && n.isFinite()) out[id] = n.toLong()
            }
            return out
        }
        return NoteState(read("liked"), read("boosted"), read("zapped"))
    }

    fun noteStateJson(state: NoteState): String {
        fun obj(m: Map<String, Long>) = m.entries.joinToString(",", "{", "}") { (k, v) -> "${jsonQuote(k)}:$v" }
        return "{\"liked\":${obj(state.liked)},\"boosted\":${obj(state.boosted)},\"zapped\":${obj(state.zapped)}}"
    }

    /** Keep the newest entries of each map when a state grows past the limit. */
    fun trimNoteState(state: NoteState, limit: Int = STATE_LIMIT): NoteState {
        fun trim(m: Map<String, Long>): Map<String, Long> =
            if (m.size <= limit) m else m.entries.sortedByDescending { it.value }.take(limit).associate { it.key to it.value }
        return NoteState(trim(state.liked), trim(state.boosted), trim(state.zapped))
    }

    /** web: URLSearchParams-style encoding, for the nostrconnect:// query. */
    internal fun formEncode(s: String): String = URLEncoder.encode(s, "UTF-8")
}
