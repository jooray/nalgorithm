package today.cypherpunk.nalgorithm.hosted

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.core.AppJson
import today.cypherpunk.nalgorithm.model.EmbeddedPost
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nostrsignin.Bech32

class HostedSnapshotTest {
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

    private fun snap(n: Int, extra: Int = 0) = HostedSnapshot(
        createdAt = 1_800_000_000,
        hoursBack = 24,
        posts = List(n) { i -> ScoredPost("p$i", PostType.Original, if (i < n / 2) a else b, "x".repeat(extra), 1) },
        profiles = mapOf(a to ProfileData(a, "A"), b to ProfileData(b, "B")),
    )

    @Test fun `oversize snapshots lose the lowest-ranked posts and the profiles only those needed`() {
        val big = snap(40, 1000)
        val out = trimSnapshot(big, 12_000, 200)
        assertTrue(AppJson.encodeToString(HostedSnapshot.serializer(), out).length <= 12_000)
        assertTrue(out.posts.isNotEmpty() && out.posts.size < 40)
        assertEquals(big.posts.take(out.posts.size).map { it.id }, out.posts.map { it.id })
        assertEquals(setOf(a), out.profiles.keys)
        assertEquals("a post count cap applies too", 200, trimSnapshot(snap(300), Int.MAX_VALUE, 200).posts.size)
    }

    @Test fun `a stored snapshot keeps its fresh ids and round-trips`() {
        val s = snap(2).copy(fresh = listOf("p0"))
        val back = AppJson.decodeFromString(HostedSnapshot.serializer(), AppJson.encodeToString(HostedSnapshot.serializer(), trimSnapshot(s)))
        assertEquals(listOf("p0"), back.fresh)
        assertEquals(2, back.posts.size)
    }

    @Test fun `profiles of boosted, quoted and mentioned people are kept`() {
        val c = "c".repeat(64)
        val post = ScoredPost(
            "p", PostType.Boost, a, "hello nostr:${Bech32.npub(c)}!", 1,
            originalPost = EmbeddedPost("o", b, "orig"),
        )
        assertEquals(setOf(a, b, c), postPubkeys(post))
        val nprofile = Bech32.encode("nprofile", byteArrayOf(0, 32) + ByteArray(32) { 0xcc.toByte() } + byteArrayOf(1, 3, 'a'.code.toByte(), 'b'.code.toByte(), 'c'.code.toByte()))
        assertEquals(setOf(a, c), postPubkeys(ScoredPost("q", PostType.Original, a, "see nostr:$nprofile", 1)))
    }
}
