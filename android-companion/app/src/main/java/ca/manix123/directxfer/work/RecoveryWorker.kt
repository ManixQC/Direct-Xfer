package ca.manix123.directxfer.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import ca.manix123.directxfer.DirectXferApplication
import ca.manix123.directxfer.data.TransferState
import ca.manix123.directxfer.security.SecureStore

class RecoveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as DirectXferApplication
        // Item 22: respect the global pause across reboots and app updates.
        if (SecureStore(applicationContext).pausedAll) return Result.success()
        val db = app.database
        val staleBefore = System.currentTimeMillis() - STALE_AFTER_MS
        val records = db.listRecoverableTransfers(staleBefore)
        for (record in records) {
            if (record.state == TransferState.RUNNING) {
                db.markQueuedForRecovery(record.id, "Reprise après interruption Android")
            }
            TransferScheduler.enqueue(applicationContext, record.id)
        }
        return Result.success()
    }

    companion object {
        const val STALE_AFTER_MS = 2 * 60 * 1000L
    }
}
