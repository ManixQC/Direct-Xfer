package ca.manix123.directxfer.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import ca.manix123.directxfer.security.SecureStore
import java.util.concurrent.TimeUnit

object TransferScheduler {
    private const val UPLOAD_PREFIX = "direct-xfer-upload-"
    private const val UPLOAD_TAG = "direct-xfer-upload"
    private const val RECOVERY_NOW = "direct-xfer-recovery-now"
    private const val RECOVERY_PERIODIC = "direct-xfer-recovery-watchdog"

    fun enqueue(context: Context, transferId: String, replace: Boolean = false) {
        val store = SecureStore(context)
        // Item 22: while globally paused, never (re)schedule uploads.
        if (store.pausedAll) return
        // Item 8: honour the Wi-Fi-only preference.
        val network = if (store.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(Data.Builder().putString(UploadWorker.KEY_TRANSFER_ID, transferId).build())
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .addTag(UPLOAD_TAG)
            .addTag(UPLOAD_PREFIX + transferId)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UPLOAD_PREFIX + transferId,
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            request
        )
    }

    /** Item 22: pause every upload and remember the paused state across restarts. */
    fun pauseAll(context: Context) {
        val app = context.applicationContext as ca.manix123.directxfer.DirectXferApplication
        SecureStore(context).pausedAll = true
        WorkManager.getInstance(context).cancelAllWorkByTag(UPLOAD_TAG)
        app.database.markAllRunningQueued()
    }

    /** Item 22: clear the paused state and re-enqueue everything still pending. */
    fun resumeAll(context: Context) {
        SecureStore(context).pausedAll = false
        kickRecovery(context)
    }

    fun retry(context: Context, transferId: String) {
        val app = context.applicationContext as ca.manix123.directxfer.DirectXferApplication
        app.database.resetForRetry(transferId)
        enqueue(context, transferId, replace = true)
    }

    fun cancel(context: Context, transferId: String) {
        val app = context.applicationContext as ca.manix123.directxfer.DirectXferApplication
        app.database.cancel(transferId)
        WorkManager.getInstance(context).cancelUniqueWork(UPLOAD_PREFIX + transferId)
    }

    fun kickRecovery(context: Context) {
        val request = OneTimeWorkRequestBuilder<RecoveryWorker>()
            .addTag("direct-xfer-recovery")
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            RECOVERY_NOW,
            ExistingWorkPolicy.REPLACE,
            request
        )
    }

    fun scheduleRecoveryWatchdog(context: Context) {
        val request = PeriodicWorkRequestBuilder<RecoveryWorker>(15, TimeUnit.MINUTES)
            .addTag("direct-xfer-recovery")
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            RECOVERY_PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }
}
