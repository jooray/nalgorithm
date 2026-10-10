package today.cypherpunk.nalgorithm.audio

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import today.cypherpunk.nalgorithm.graph
import java.util.concurrent.TimeUnit

/**
 * Every few hours, on any network: fetch the newest hosted digest's audio into the
 * offline cache, so the morning digest is ready before the app is opened. Does nothing
 * outside hosted mode, signed out, or with offline audio turned off.
 */
class LatestDigestWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.Main) {
        runCatching { applicationContext.graph.audio.fetchLatestInBackground() }
        Result.success()
    }

    companion object {
        private const val NAME = "nalgorithm-latest-digest-audio"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<LatestDigestWorker>(3, TimeUnit.HOURS, 1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            runCatching {
                WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
            }
        }
    }
}
