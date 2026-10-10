package today.cypherpunk.nalgorithm.nostr

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nalgorithm.nostr.NoteLogic.Checked
import java.math.BigInteger

/** A port of web/test/note-logic.test.mjs. */
class NoteLogicTest {
    private fun pk(c: Char) = c.toString().repeat(64)
    private val me = pk('a')
    private val author = pk('b')
    private val id = pk('1')
    private val root = pk('2')

    private fun ev(id: String, t: Long, tags: List<List<String>>, kind: Int = 1) = NostrEvent(id, author, t, kind, tags, "", "")

    // ─── NIP-10 ──────────────────────────────────────────────────────────────

    @Test fun replyToTopLevelNote() {
        val tags = NoteLogic.replyTags(id, author, emptyList(), "wss://r.example", me)
        assertEquals(listOf(listOf("e", id, "wss://r.example", "root", author), listOf("p", author)), tags)
    }

    @Test fun replyToAReply() {
        val parentTags = listOf(
            listOf("e", root, "wss://root.example", "root", pk('c')),
            listOf("e", pk('3'), "", "reply"),
            listOf("p", pk('c')), listOf("p", me), listOf("p", author), listOf("p", pk('d')),
        )
        val tags = NoteLogic.replyTags(id, author, parentTags, "wss://r.example", me)
        assertEquals(listOf("e", root, "wss://root.example", "root", pk('c')), tags[0])
        assertEquals(listOf("e", id, "wss://r.example", "reply", author), tags[1])
        assertEquals(listOf(listOf("p", author), listOf("p", pk('c')), listOf("p", pk('d'))), tags.drop(2))
    }

    @Test fun positionalTagsStillFindTheRoot() {
        val tags = NoteLogic.replyTags(id, author, listOf(listOf("e", root), listOf("e", pk('3'))))
        assertEquals(root, tags[0][1])
        assertEquals("root", tags[0][3])
        assertEquals("reply", tags[1][3])
    }

    @Test fun rootRelayFallsBackToTheAuthorsPTagHint() {
        val tags = NoteLogic.replyTags(id, author, listOf(listOf("e", root, "", "root", pk('c')), listOf("p", pk('c'), "wss://hint.example")))
        assertEquals(listOf("e", root, "wss://hint.example", "root", pk('c')), tags[0])
    }

    @Test fun replyTemplateIsKind1WithTrimmedContent() {
        val t = NoteLogic.replyTemplate("  hi  ", id, author, emptyList(), created = 5)
        assertEquals(1, t.kind)
        assertEquals("hi", t.content)
        assertEquals(5L, t.createdAt)
    }

    @Test fun pTagsAreCappedAt20() {
        val tags = NoteLogic.replyTags(id, author, (0 until 50).map { listOf("p", it.toString(16).padStart(64, '0')) })
        assertEquals(20, tags.count { it[0] == "p" })
    }

    @Test fun parentOfAndDirectRepliesIgnoreMentions() {
        val events = listOf(
            ev(pk('5'), 30, listOf(listOf("e", id, "", "root"))),
            ev(pk('6'), 10, listOf(listOf("e", id, "", "reply"))),
            ev(pk('7'), 20, listOf(listOf("e", id, "", "mention"))),
            ev(pk('8'), 15, listOf(listOf("e", root, "", "root"), listOf("e", id, "", "reply"))),
            ev(pk('6'), 10, listOf(listOf("e", id, "", "reply"))),
        )
        assertEquals(listOf(10L, 15L, 30L), NoteLogic.directReplies(events, id).map { it.createdAt })
        assertEquals(2, NoteLogic.directReplies(events, id, 2).size)
        assertNull(NoteLogic.parentOf(emptyList()))
        assertEquals(id, NoteLogic.parentOf(listOf(listOf("e", root, "", "root"), listOf("e", id, "", "reply")))!!.id)
    }

    // ─── 7, 6, 16 ────────────────────────────────────────────────────────────

    @Test fun likeIsKind7Plus() {
        val t = NoteLogic.likeTemplate(NoteLogic.Target(id, author, 1, "wss://r.example"), 9)
        assertEquals(7, t.kind)
        assertEquals("+", t.content)
        assertEquals(listOf(listOf("e", id, "wss://r.example", author), listOf("p", author, ""), listOf("k", "1")), t.tags)
    }

    @Test fun boostOfKind1IsKind6WithOriginalJson() {
        val original = NostrEvent(id, author, 1, 1, emptyList(), "x", "s")
        val t = NoteLogic.repostTemplate(NoteLogic.Target(id, author, 1), original, 9)
        assertEquals(6, t.kind)
        assertEquals(id, (relayJson.parseToJsonElement(t.content) as JsonObject)["id"]!!.let { (it as JsonPrimitive).content })
        assertEquals(listOf(listOf("e", id, ""), listOf("p", author)), t.tags)
    }

    @Test fun boostOfOtherKindsIsKind16() {
        val t = NoteLogic.repostTemplate(NoteLogic.Target(id, author, 30023), null, 9)
        assertEquals(16, t.kind)
        assertEquals("", t.content)
        assertEquals(listOf("k", "30023"), t.tags.last())
    }

    @Test fun originalWithDifferentIdIsNeverEmbedded() {
        val t = NoteLogic.repostTemplate(NoteLogic.Target(id, author, 1), NostrEvent(root, author, 1, 1, emptyList(), "", ""))
        assertEquals("", t.content)
    }

    // ─── Relays ──────────────────────────────────────────────────────────────

    @Test fun normalizeRelay() {
        assertEquals("wss://relay.example.com", NoteLogic.normalizeRelay(" wss://Relay.Example.com/ "))
        assertEquals("", NoteLogic.normalizeRelay("ws://relay.example.com"))
        assertEquals("ws://localhost:7777", NoteLogic.normalizeRelay("ws://localhost:7777"))
        assertEquals("", NoteLogic.normalizeRelay("https://relay.example.com"))
        assertEquals("", NoteLogic.normalizeRelay("wss://u:p@relay.example.com"))
        assertEquals("", NoteLogic.normalizeRelay("nonsense"))
        assertEquals("wss://relay.example.com/inbox", NoteLogic.normalizeRelay("wss://relay.example.com:443/inbox/"))
    }

    @Test fun parseRelayList() {
        val list = NoteLogic.parseRelayList(
            listOf(listOf("r", "wss://a.example"), listOf("r", "wss://b.example", "read"), listOf("r", "wss://c.example", "write"), listOf("r", "http://bad"), listOf("p", "x")),
        )
        assertEquals(listOf("wss://a.example", "wss://b.example"), list.read)
        assertEquals(listOf("wss://a.example", "wss://c.example"), list.write)
    }

    @Test fun selectPublishRelays() {
        val defaults = listOf("wss://d1.example", "wss://d2.example")
        assertEquals(listOf("wss://w.example", "wss://p.example"), NoteLogic.selectPublishRelays(listOf("wss://w.example"), defaults, listOf("wss://p.example", "wss://w.example")))
        assertEquals(defaults, NoteLogic.selectPublishRelays(null, defaults, null))
        assertEquals(defaults + "wss://p.example", NoteLogic.selectPublishRelays(emptyList(), defaults, listOf("wss://p.example")))
    }

    @Test fun describePublish() {
        assertEquals("Published to 2 of 3 relays", NoteLogic.describePublish(listOf(RelayResult("a", true), RelayResult("b", false), RelayResult("c", true))))
        assertEquals("No relay accepted it (0 of 1)", NoteLogic.describePublish(listOf(RelayResult("a", false))))
        assertEquals("Published to 1 of 1 relay", NoteLogic.describePublish(listOf(RelayResult("a", true))))
        assertEquals("No relays to publish to", NoteLogic.describePublish(emptyList()))
    }

    // ─── LNURL ───────────────────────────────────────────────────────────────

    @Test fun lnurlRoundTrips() {
        val url = "https://walletofsatoshi.com/.well-known/lnurlp/someone"
        val enc = NoteLogic.lnurlEncode(url)
        assertTrue(enc.startsWith("lnurl1"))
        assertEquals(url, NoteLogic.lnurlDecode(enc))
        assertEquals(url, NoteLogic.lnurlDecode(enc.uppercase()))
        assertNull(NoteLogic.lnurlDecode(NoteLogic.lnurlEncode("http://insecure.example/x")))
        assertNull(NoteLogic.lnurlDecode(enc.dropLast(1) + if (enc.endsWith("q")) "p" else "q"))
    }

    @Test fun lightningAddresses() {
        assertEquals("https://bednar.io/.well-known/lnurlp/juraj", NoteLogic.lightningAddressUrl("Juraj@Bednar.io"))
        assertNull(NoteLogic.parseLightningAddress("not an address"))
        assertNull(NoteLogic.parseLightningAddress("a@localhost"))
        val t = NoteLogic.payTarget("x@y.example", "junk")!!
        assertEquals("https://y.example/.well-known/lnurlp/x", t.url)
        assertEquals("x@y.example", t.address)
        assertNull(NoteLogic.payTargetFromProfile(JsonObject(emptyMap())))
        assertNull(NoteLogic.payTargetFromProfile(buildJsonObject { put("lud16", 12) }))
        val via06 = NoteLogic.payTarget(null, NoteLogic.lnurlEncode("https://y.example/pay"))!!
        assertEquals("https://y.example/pay", via06.url)
        assertEquals("y.example", via06.label)
        assertEquals("https://y.example/.well-known/lnurlp/a%2Bb", NoteLogic.lightningAddressUrl("a+b@y.example"))
    }

    private fun goodParams(edit: MutableMap<String, Any?>.() -> Unit = {}): JsonObject {
        val m = mutableMapOf<String, Any?>(
            "tag" to "payRequest", "callback" to "https://y.example/cb", "minSendable" to 1000, "maxSendable" to 500000000,
            "allowsNostr" to true, "nostrPubkey" to pk('e'), "commentAllowed" to 100,
        )
        m.edit()
        return JsonObject(
            m.mapValues { (_, v) ->
                when (v) {
                    is String -> JsonPrimitive(v)
                    is Number -> JsonPrimitive(v)
                    is Boolean -> JsonPrimitive(v)
                    else -> kotlinx.serialization.json.JsonNull
                }
            },
        )
    }

    @Test fun parsePayParamsAcceptsAGoodResponse() {
        val r = NoteLogic.parsePayParams(goodParams())
        assertTrue(r is Checked.Ok)
        assertEquals(100, (r as Checked.Ok).value.commentAllowed)
    }

    @Test fun parsePayParamsRejectsBadInput() {
        fun bad(edit: MutableMap<String, Any?>.() -> Unit) = assertTrue(NoteLogic.parsePayParams(goodParams(edit)) is Checked.Fail)
        bad { put("callback", "http://y.example/cb") }
        bad { put("callback", "javascript:alert(1)") }
        bad { put("callback", "https://u:p@y.example/cb") }
        bad { put("allowsNostr", false) }
        bad { put("allowsNostr", "true") }
        bad { put("nostrPubkey", "abc") }
        bad { put("minSendable", 5000); put("maxSendable", 1000) }
        bad { put("tag", "withdrawRequest") }
        assertTrue(NoteLogic.parsePayParams(buildJsonObject { put("status", "ERROR"); put("reason", "x") }) is Checked.Fail)
        assertTrue(NoteLogic.parsePayParams(null) is Checked.Fail)
        assertTrue(NoteLogic.parsePayParams(JsonPrimitive("text")) is Checked.Fail)
    }

    @Test fun checkAmount() {
        assertEquals(Checked.Ok(10000L), NoteLogic.checkAmount(10000.0, 1000000.0, 10.0))
        assertTrue(NoteLogic.checkAmount(10000.0, 1000000.0, 9.0) is Checked.Fail)
        assertTrue(NoteLogic.checkAmount(10000.0, 1000000.0, 1001.0) is Checked.Fail)
        assertTrue(NoteLogic.checkAmount(10000.0, 1000000.0, 1.5) is Checked.Fail)
        assertTrue(NoteLogic.checkAmount(10000.0, 1000000.0, 0.0) is Checked.Fail)
        assertTrue((NoteLogic.checkAmount(10000.0, 1000000.0, 9.0) as Checked.Fail).error.contains("smallest"))
        assertEquals("The largest zap this address accepts is 1,000 sats.", (NoteLogic.checkAmount(10000.0, 1000000.0, 5000.0) as Checked.Fail).error)
    }

    @Test fun buildInvoiceUrl() {
        val url = NoteLogic.buildInvoiceUrl("https://y.example/cb?k=1", 5, 21000, "{\"a\":1}", "lnurl1x", "toolongcomment").toHttpUrl()
        assertEquals("1", url.queryParameter("k"))
        assertEquals("21000", url.queryParameter("amount"))
        assertEquals("{\"a\":1}", url.queryParameter("nostr"))
        assertEquals("lnurl1x", url.queryParameter("lnurl"))
        assertEquals("toolo", url.queryParameter("comment"))
        val none = NoteLogic.buildInvoiceUrl("https://y.example/cb", 0, 1000, "{}", "l", "hi").toHttpUrl()
        assertNull(none.queryParameter("comment"))
    }

    // ─── Zap request ─────────────────────────────────────────────────────────

    @Test fun zapRequestTemplate() {
        val t = NoteLogic.zapRequestTemplate(author, id, 1, 21000, listOf("wss://a.example", "wss://b.example"), "lnurl1x", " gm ", 7)
        assertEquals(9734, t.kind)
        assertEquals("gm", t.content)
        assertEquals(
            listOf(listOf("relays", "wss://a.example", "wss://b.example"), listOf("amount", "21000"), listOf("lnurl", "lnurl1x"), listOf("p", author), listOf("e", id), listOf("k", "1")),
            t.tags,
        )
        assertFalse(NoteLogic.zapRequestTemplate(author, null, null, 1000, emptyList(), "l").tags.any { it[0] == "e" })
    }

    // ─── bolt11 ──────────────────────────────────────────────────────────────

    private fun words(n: Int, len: Int) = (0 until len).map { (n + it) % 32 }

    private fun hexToWords(hex: String): List<Int> {
        val bits = hex.chunked(2).joinToString("") { it.toInt(16).toString(2).padStart(8, '0') }
        val padded = bits.padEnd((bits.length + 4) / 5 * 5, '0')
        return padded.chunked(5).map { it.toInt(2) }
    }

    /** A synthetic but structurally valid invoice: timestamp, h tag, expiry, dummy signature. */
    private fun invoice(amountPart: String, hashHex: String): String {
        val ts = listOf(0, 0, 0, 0, 0, 0, 1)
        val h = listOf(23, 1, 20) + hexToWords(hashHex)
        val x = listOf(6, 0, 2, 0, 30)
        return NoteLogic.bech32EncodeWords("lnbc$amountPart", ts + h + x + words(3, 104))
    }

    @Test fun parseBolt11Amount() {
        assertEquals(BigInteger.valueOf(250000000), NoteLogic.parseBolt11Amount("lnbc2500u1pxyz"))
        assertEquals(BigInteger.valueOf(100000000), NoteLogic.parseBolt11Amount("lnbc1m1pxyz"))
        assertEquals(BigInteger.valueOf(2000), NoteLogic.parseBolt11Amount("lnbc20n1pxyz"))
        assertEquals(BigInteger.valueOf(123), NoteLogic.parseBolt11Amount("lnbc1230p1pxyz"))
        assertNull(NoteLogic.parseBolt11Amount("lnbc1pxyz"))
        assertEquals(BigInteger.valueOf(100000), NoteLogic.parseBolt11Amount("lnbc1u1pxyz"))
        assertNull(NoteLogic.parseBolt11Amount("lnbc15p1pxyz"))
        assertEquals(BigInteger.valueOf(2100000), NoteLogic.parseBolt11Amount("lntb21u1pxyz"))
        assertEquals(BigInteger.valueOf(1000000), NoteLogic.parseBolt11Amount("lnbcrt10u1pxyz"))
        assertNull(NoteLogic.parseBolt11Amount("garbage"))
    }

    @Test fun bech32AgreesWithNip19() {
        val hex = "b".repeat(64)
        assertEquals(Nip19.npub(hex), NoteLogic.bech32Encode("npub", Hex.decode(hex)))
        assertNotNull(NoteLogic.bech32Decode(Nip19.npub(hex)))
    }

    @Test fun decodeBolt11() {
        val hash = "ab".repeat(32)
        val d = NoteLogic.decodeBolt11(invoice("10u", hash))!!
        assertEquals(BigInteger.valueOf(1000000), d.amountMsats)
        assertEquals(hash, d.descriptionHash)
        assertEquals(30L, d.expiry)
        assertEquals(1L, d.timestamp)
    }

    @Test fun decodeBolt11RejectsACorruptedChecksum() {
        val inv = invoice("10u", "ab".repeat(32))
        assertNotNull(NoteLogic.decodeBolt11(inv))
        assertNull(NoteLogic.decodeBolt11(inv.dropLast(1) + if (inv.endsWith("q")) "p" else "q"))
    }

    // ─── Invoice and receipt validation ──────────────────────────────────────

    private data class Scenario(val zr: NostrEvent, val json: String, val hash: String, val inv: String)

    private fun scenario(): Scenario {
        val zr = NostrEvent(pk('4'), me, 10, 9734, listOf(listOf("amount", "21000"), listOf("p", author), listOf("e", id)), "", "x".repeat(128))
        val json = zr.toJsonString()
        val hash = sha256Hex(json)
        return Scenario(zr, json, hash, invoice("210n", hash))
    }

    @Test fun validateInvoiceAcceptsAMatchingInvoice() {
        val s = scenario()
        assertTrue(NoteLogic.validateInvoice(JsonPrimitive(s.inv), 21000, s.json) is Checked.Ok)
    }

    @Test fun validateInvoiceRejectsMismatches() {
        val s = scenario()
        val wrongAmount = NoteLogic.validateInvoice(JsonPrimitive(s.inv), 100000, s.json)
        assertEquals("The invoice is for 21 sats, not the 100 you chose, so I did not use it.", (wrongAmount as Checked.Fail).error)
        assertTrue(NoteLogic.validateInvoice(JsonPrimitive(invoice("210n", "cd".repeat(32))), 21000, s.json) is Checked.Fail)
        assertTrue(NoteLogic.validateInvoice(JsonPrimitive(invoice("", s.hash)), 21000, s.json) is Checked.Fail)
        assertTrue(NoteLogic.validateInvoice(JsonPrimitive("not an invoice"), 21000, s.json) is Checked.Fail)
        assertTrue(NoteLogic.validateInvoice(JsonPrimitive(1), 21000, s.json) is Checked.Fail)
        assertTrue(NoteLogic.validateInvoice(null, 21000, s.json) is Checked.Fail)
    }

    private fun receipt(pubkey: String, tags: List<List<String>>, kind: Int = 9735) = NostrEvent(pk('9'), pubkey, 11, kind, tags, "", "")

    @Test fun validateReceiptAcceptsTheGenuineReceipt() {
        val s = scenario()
        val r = NoteLogic.validateReceipt(receipt(pk('e'), listOf(listOf("p", author), listOf("e", id), listOf("bolt11", s.inv), listOf("description", s.json))), s.zr, s.json, pk('e'), s.inv)
        assertEquals(Checked.Ok(21000L), r)
    }

    @Test fun validateReceiptRejectsForgeries() {
        val s = scenario()
        val np = pk('e')
        val base = listOf(listOf("bolt11", s.inv), listOf("description", s.json))
        fun check(r: NostrEvent, invoice: String = s.inv) = NoteLogic.validateReceipt(r, s.zr, s.json, np, invoice)
        assertTrue(check(receipt(np, base)) is Checked.Ok)
        assertTrue(check(receipt(pk('f'), base)) is Checked.Fail)
        assertTrue(check(receipt(np, base, kind = 1)) is Checked.Fail)
        assertTrue(check(receipt(np, listOf(listOf("bolt11", invoice("210n", sha256Hex("other"))), listOf("description", s.json)))) is Checked.Fail)
        assertTrue(check(receipt(np, listOf(listOf("bolt11", s.inv)))) is Checked.Fail)
        assertTrue(check(receipt(np, listOf(listOf("bolt11", s.inv), listOf("description", "{\"id\":\"x\"}")))) is Checked.Fail)
        assertTrue(check(receipt(np, listOf(listOf("bolt11", s.inv), listOf("description", "nope")))) is Checked.Fail)
        val other = invoice("100n", s.hash)
        assertTrue(check(receipt(np, listOf(listOf("bolt11", other), listOf("description", s.json))), other) is Checked.Fail)
        assertTrue(check(receipt(np, base), other) is Checked.Fail)
    }

    // ─── Local state ─────────────────────────────────────────────────────────

    @Test fun noteStateParsingAndTrimming() {
        assertEquals(NoteLogic.NoteState(), NoteLogic.parseNoteState(null))
        assertEquals(NoteLogic.NoteState(), NoteLogic.parseNoteState("not json"))
        val s = NoteLogic.parseNoteState("{\"liked\":{\"$id\":5,\"nothex\":6,\"$root\":\"x\"},\"boosted\":[],\"zapped\":{\"$id\":21}}")
        assertEquals(NoteLogic.NoteState(liked = mapOf(id to 5L), zapped = mapOf(id to 21L)), s)
        val big = NoteLogic.NoteState(liked = mapOf("a" to 1L, "b" to 3L, "c" to 2L))
        assertEquals(mapOf("b" to 3L, "c" to 2L), NoteLogic.trimNoteState(big, 2).liked)
        assertEquals(s, NoteLogic.parseNoteState(NoteLogic.noteStateJson(s)))
    }
}
