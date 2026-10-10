package today.cypherpunk.nalgorithm.audio

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import today.cypherpunk.nalgorithm.audio.OfflineAudioCache.SavedAudio
import today.cypherpunk.nalgorithm.core.RecordStore
import java.io.File
import java.io.IOException
import android.content.Context

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineAudioCacheTest {
    private val mb = 1024L * 1024

    @Test fun `evictions keep the newest three of one owner within the budget`() {
        val records = (1..4).map { "audio:a:$it" to SavedAudio("a", "$it", it.toLong(), mb, "f$it") } +
            ("audio:b:x" to SavedAudio("b", "x", 9, mb, "fb"))
        assertEquals(setOf("audio:a:1", "audio:b:x"), OfflineAudioCache.evictions(records, "a").toSet())
    }

    @Test fun `evictions honor the byte budget, newest first`() {
        val records = listOf(
            "audio:a:1" to SavedAudio("a", "1", 1, 10 * mb, "f1"),
            "audio:a:2" to SavedAudio("a", "2", 2, 12 * mb, "f2"),
            "audio:a:3" to SavedAudio("a", "3", 3, 12 * mb, "f3"),
        )
        // 12 + 12 fit in 30 MB; the oldest 10 MB would make 34.
        assertEquals(listOf("audio:a:1"), OfflineAudioCache.evictions(records, "a"))
    }

    private fun cache(): Pair<OfflineAudioCache, File> {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val dir = File(context.filesDir, "audio-test-${System.nanoTime()}")
        return OfflineAudioCache(dir, RecordStore(context), OkHttpClient()) to dir
    }

    private fun blob(dir: File, text: String): File = File(dir.parentFile, "src-${System.nanoTime()}.mp3").apply { writeText(text) }

    @Test fun `retains newest three, restores files and isolates readers`() = runTest {
        val (cache, dir) = cache()
        cache.clear()
        for (n in 1..4) cache.save("reader-a", "$n", n.toLong(), blob(dir, "audio$n"))
        assertNull(cache.read("reader-a", "1"))
        assertEquals("audio4", cache.read("reader-a", "4")!!.readText())
        assertNull(cache.read("reader-b", "4"))
        cache.save("reader-b", "b", 5, blob(dir, "new-reader"))
        assertNull(cache.read("reader-a", "4"))
        assertNotNull(cache.read("reader-b", "b"))
        cache.clear()
        assertEquals(0L, cache.bytes())
        assertNull(cache.read("reader-b", "b"))
    }

    @Test fun `audio older than the cached three is not kept`() = runTest {
        val (cache, dir) = cache()
        cache.clear()
        for (n in 5..7) assertTrue(cache.save("r", "$n", n.toLong(), blob(dir, "x$n")))
        assertFalse(cache.save("r", "old", 1, blob(dir, "old")))
        assertNull(cache.read("r", "old"))
    }

    @Test fun `oversized audio is refused before it can exceed the budget`() = runTest {
        val (cache, dir) = cache()
        val big = File(dir.parentFile, "big.mp3")
        java.io.RandomAccessFile(big, "rw").use { it.setLength(OfflineAudioCache.AUDIO_ITEM_MAX_BYTES + 1) }
        try {
            cache.save("r", "big", 1, big)
            fail("expected too large")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("too large"))
        } finally {
            big.delete()
        }
    }
}
