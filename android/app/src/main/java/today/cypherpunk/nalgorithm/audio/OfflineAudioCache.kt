package today.cypherpunk.nalgorithm.audio

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import today.cypherpunk.nalgorithm.core.RecordStore
import today.cypherpunk.nalgorithm.mode.AudioSource
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * The newest three digests' audio kept on this phone (web/src/offline-audio.ts):
 * at most 30 MB in all and 15 MB each, for one owner (mode + identity) at a time.
 * Files live under filesDir/audio; the index is in the [RecordStore] under `audio:`.
 */
class OfflineAudioCache(
    private val dir: File,
    private val records: RecordStore,
    http: OkHttpClient,
) {
    companion object {
        const val AUDIO_COUNT = 3
        const val AUDIO_MAX_BYTES = 30L * 1024 * 1024
        const val AUDIO_ITEM_MAX_BYTES = 15L * 1024 * 1024
        const val DOWNLOAD_MAX_BYTES = 60L * 1024 * 1024
        private const val PREFIX = "audio:"

        fun keyOf(owner: String, id: String): String = "$PREFIX$owner:$id"

        /**
         * Which records stay: newest first, only [owner]'s (another identity's or mode's go),
         * at most [count] and [maxBytes] in all. Returns the keys to delete.
         */
        fun evictions(records: List<Pair<String, SavedAudio>>, owner: String, count: Int = AUDIO_COUNT, maxBytes: Long = AUDIO_MAX_BYTES): List<String> {
            val sorted = records.sortedByDescending { it.second.createdAt }
            var kept = 0
            var bytes = 0L
            val drop = ArrayList<String>()
            for ((key, value) in sorted) {
                if (value.owner != owner || kept >= count || bytes + value.bytes > maxBytes) drop.add(key)
                else { kept++; bytes += value.bytes }
            }
            return drop
        }
    }

    @Serializable
    data class SavedAudio(val owner: String, val id: String, val createdAt: Long, val bytes: Long, val file: String)

    private val http = http.newBuilder().callTimeout(60, TimeUnit.SECONDS).build()
    private val tmpDir get() = File(dir, "tmp")
    private val lock = Mutex()
    private val pending = HashMap<String, CompletableDeferred<File>>()

    private fun fileName(owner: String, id: String): String {
        val hash = MessageDigest.getInstance("SHA-256").digest("$owner:$id".toByteArray())
        return hash.joinToString("") { "%02x".format(it) }.take(40) + ".mp3"
    }

    /** The cached file, or null when this digest's audio is not on the phone. */
    suspend fun read(owner: String, id: String): File? {
        val saved = records.get(keyOf(owner, id), SavedAudio.serializer()) ?: return null
        val file = File(dir, saved.file)
        return withContext(Dispatchers.IO) { file.takeIf { it.isFile && it.length() == saved.bytes } }
    }

    /**
     * Keep [source] as this digest's audio. Returns whether it stayed: audio for an older
     * digest than the three cached ones is evicted at once.
     */
    suspend fun save(owner: String, id: String, createdAt: Long, source: File): Boolean = lock.withLock {
        val size = withContext(Dispatchers.IO) { source.length() }
        if (size > AUDIO_ITEM_MAX_BYTES) throw IOException("Audio is too large for the offline cache. Download the MP3 instead.")
        val name = fileName(owner, id)
        val target = File(dir, name)
        withContext(Dispatchers.IO) {
            dir.mkdirs()
            if (source.canonicalPath != target.canonicalPath) {
                val inTmp = source.parentFile?.canonicalPath == tmpDir.canonicalPath
                if (!(inTmp && source.renameTo(target))) {
                    source.copyTo(target, overwrite = true)
                    if (inTmp) source.delete()
                }
            }
        }
        records.put(keyOf(owner, id), SavedAudio.serializer(), SavedAudio(owner, id, createdAt, size, name))
        val all = records.list(PREFIX, SavedAudio.serializer())
        val drop = evictions(all, owner).toSet()
        for ((key, value) in all) {
            if (key !in drop) continue
            records.delete(key)
            withContext(Dispatchers.IO) { File(dir, value.file).delete() }
        }
        keyOf(owner, id) !in drop
    }

    /**
     * This digest's audio as a file: the cached one, else downloaded (with the source's
     * headers) into a temporary file the caller saves or deletes. One download per digest at a time.
     */
    suspend fun fetch(owner: String, id: String, source: AudioSource, maxBytes: Long = AUDIO_ITEM_MAX_BYTES): File {
        read(owner, id)?.let { return it }
        if (source is AudioSource.Local) return source.file
        val key = keyOf(owner, id)
        val (deferred, mine) = lock.withLock {
            pending[key]?.let { it to false } ?: CompletableDeferred<File>().also { pending[key] = it }.let { it to true }
        }
        if (!mine) return deferred.await()
        try {
            val file = download(source as AudioSource.Remote, maxBytes)
            deferred.complete(file)
            return file
        } catch (e: Throwable) {
            deferred.completeExceptionally(e)
            throw e
        } finally {
            lock.withLock { pending.remove(key) }
        }
    }

    private suspend fun download(source: AudioSource.Remote, maxBytes: Long): File = withContext(Dispatchers.IO) {
        if (safeAudioUrl(source.url) == null) throw IOException("Unsafe audio address.")
        val request = Request.Builder().url(source.url).apply { source.headers.forEach { (k, v) -> header(k, v) } }.build()
        tmpDir.mkdirs()
        val out = File.createTempFile("dl-", ".mp3", tmpDir)
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException("Audio download failed. Check your connection.")
                val body = response.body
                val length = response.header("Content-Length")?.toLongOrNull() ?: -1L
                if (length > maxBytes) throw IOException("Audio is too large for this download.")
                var bytes = 0L
                body.byteStream().use { input ->
                    out.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            bytes += n
                            if (bytes > maxBytes) throw IOException("Audio exceeded the download size limit.")
                            output.write(buffer, 0, n)
                        }
                    }
                }
                if (bytes == 0L) throw IOException("Audio download failed. Check your connection.")
            }
            out
        } catch (e: Throwable) {
            out.delete()
            if (e is IOException && e.message?.startsWith("Audio") == true || e.message == "Unsafe audio address.") throw e
            throw IOException("Audio download failed. Check your connection.", e)
        }
    }

    /** Throw away a temporary download that was not kept. */
    fun discard(file: File) {
        if (file.parentFile?.canonicalPath == tmpDir.canonicalPath) file.delete()
    }

    suspend fun bytes(): Long = records.list(PREFIX, SavedAudio.serializer()).sumOf { it.second.bytes }

    suspend fun clear() = lock.withLock {
        records.clear(PREFIX)
        withContext(Dispatchers.IO) {
            dir.listFiles()?.forEach { it.deleteRecursively() }
        }
    }
}
