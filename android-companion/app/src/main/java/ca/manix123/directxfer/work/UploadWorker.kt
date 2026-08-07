package ca.manix123.directxfer.work

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import android.os.SystemClock
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import ca.manix123.directxfer.DirectXferApplication
import ca.manix123.directxfer.R
import ca.manix123.directxfer.data.TransferMode
import ca.manix123.directxfer.data.TransferRecord
import ca.manix123.directxfer.data.TransferState
import ca.manix123.directxfer.data.UploadStage
import ca.manix123.directxfer.net.ApiException
import ca.manix123.directxfer.net.DirectXferApi
import ca.manix123.directxfer.security.SecureStore
import ca.manix123.directxfer.ui.MainActivity
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.File
import java.io.IOException

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val app = context.applicationContext as DirectXferApplication
    private val db = app.database
    private val store = SecureStore(context)
    private val api = DirectXferApi(store)
    private val transferId = inputData.getString(KEY_TRANSFER_ID).orEmpty()
    private val notificationId = transferId.hashCode() and 0x7fffffff
    // Item 20: throttle DB persistence and the cancellation lookup instead of hitting
    // SQLite on every 128 KB block.
    private var lastPersistMs = 0L
    private var lastCancelCheckMs = 0L
    private var cancelledCached = false

    override suspend fun doWork(): Result {
        var record = db.getTransfer(transferId) ?: return Result.failure()
        if (record.state == TransferState.SUCCESS || record.state == TransferState.CANCELLED) return Result.success()
        val source = File(record.filePath)
        if (!source.isFile) {
            db.fail(transferId, "Fichier local introuvable")
            return Result.failure()
        }

        db.incrementAttempts(transferId)
        db.updateProgress(transferId, TransferState.RUNNING, record.bytesSent)
        record = db.getTransfer(transferId) ?: return Result.failure()
        setForeground(foreground(record.displayName, record.bytesSent, record.bytesTotal, false))

        return try {
            // Item 21: bound how many uploads run at once (network/CPU protection).
            // Foreground is already active above; workers past the limit simply wait here.
            val resultUrl = uploadGate.withPermit {
                when (record.mode) {
                    TransferMode.IMAGE_LINK -> uploadImage(record, source)
                    TransferMode.RECEPTION -> {
                        val token = record.destinationToken ?: error("Destination manquante")
                        val server = record.destinationServer ?: store.serverUrl ?: error("Serveur manquant")
                        val uploadId = stableUploadId(record.id)
                        api.uploadReception(server, token, uploadId, source) { sent, total ->
                            progress(record.displayName, sent, total)
                        }
                        null
                    }
                }
            }
            db.finish(transferId, resultUrl)
            source.parentFile?.deleteRecursively()
            notifyFinal(record.displayName, true, resultUrl ?: applicationContext.getString(R.string.notif_transfer_done))
            Result.success()
        } catch (e: Exception) {
            val latest = db.getTransfer(transferId)
            if (latest?.state == TransferState.CANCELLED) return Result.failure()
            val message = userMessage(e)
            val retryable = e is IOException || e is ApiException && (e.status == 408 || e.status == 409 || e.status == 425 || e.status == 429 || e.status >= 500)
            if (isStopped) {
                db.markQueuedForRecovery(transferId, "Reprise automatique après interruption")
                Result.retry()
            } else if (retryable && runAttemptCount < MAX_WORK_RETRIES) {
                db.markQueuedForRecovery(transferId, "Nouvel essai : $message")
                Result.retry()
            } else {
                db.fail(transferId, message)
                notifyFinal(record.displayName, false, message)
                Result.failure()
            }
        }
    }

    // CoroutineWorker.onStopped() is final and must not be overridden: a stop cancels
    // the coroutine, so we handle it cooperatively instead. progress() throws once
    // isStopped becomes true, and the catch in doWork() marks the transfer queued for
    // recovery + returns Result.retry(); the periodic RecoveryWorker watchdog re-queues
    // anything that slipped through (e.g. stopped before the first progress tick).
    private fun uploadImage(record: TransferRecord, source: File): String {
        val dir = File(source.parentFile ?: applicationContext.filesDir, "prepared").apply { mkdirs() }
        // Item 13: apply the user's configurable image dimensions/quality.
        val prepared = ImageProcessor.prepare(
            source, record.displayName, record.cleanExif, dir,
            store.imageFullMax, store.imageThumbMax, store.imageMicroMax, store.imageQuality
        )
        val fullWeight = prepared.full.length().coerceAtLeast(1L)
        val thumbWeight = prepared.thumb.length().coerceAtLeast(1L)
        val microWeight = prepared.micro.length().coerceAtLeast(1L)
        val total = fullWeight + thumbWeight + microWeight
        db.updateTotal(transferId, total)

        var current = db.getTransfer(transferId) ?: record
        var token = current.remoteToken
        var resultUrl = current.remoteUrl
        val uploadId = stableUploadId(record.id)

        if (token.isNullOrBlank() || resultUrl.isNullOrBlank()) {
            val existing = api.findImageByUploadId(uploadId)
            val image = existing ?: api.createImage(
                prepared.full,
                prepared.uploadName,
                prepared.width,
                prepared.height,
                uploadId,
                record.cleanExif
            ) { sent, _ -> progress(record.displayName, sent, total) }
            token = image.token
            resultUrl = image.fullUrl
            db.checkpointImage(transferId, UploadStage.THUMB, token, resultUrl, fullWeight)
            current = db.getTransfer(transferId) ?: current.copy(
                remoteToken = token,
                remoteUrl = resultUrl,
                uploadStage = UploadStage.THUMB,
                bytesSent = fullWeight
            )
        }

        require(!token.isNullOrBlank() && !resultUrl.isNullOrBlank()) { "Point de reprise image invalide" }

        if (current.uploadStage.ordinal <= UploadStage.THUMB.ordinal) {
            api.uploadImageVariant(token, "thumb", prepared.thumb) { sent, _ ->
                progress(record.displayName, fullWeight + sent, total)
            }
            db.checkpointImage(
                transferId,
                UploadStage.MICRO,
                token,
                resultUrl,
                fullWeight + thumbWeight
            )
            current = db.getTransfer(transferId) ?: current.copy(uploadStage = UploadStage.MICRO)
        }

        if (current.uploadStage.ordinal <= UploadStage.MICRO.ordinal) {
            api.uploadImageVariant(token, "micro", prepared.micro) { sent, _ ->
                progress(record.displayName, fullWeight + thumbWeight + sent, total)
            }
            db.checkpointImage(transferId, UploadStage.COMPLETE, token, resultUrl, total)
        }

        return resultUrl
    }

    private fun progress(name: String, sent: Long, total: Long) {
        // Cheap stop check on every block; the DB cancellation lookup is throttled.
        if (isStopped) throw IOException("Transfert interrompu")
        val now = SystemClock.elapsedRealtime()
        if (now - lastCancelCheckMs >= CANCEL_CHECK_MS) {
            lastCancelCheckMs = now
            if (db.getTransfer(transferId)?.state == TransferState.CANCELLED) cancelledCached = true
        }
        if (cancelledCached) throw IOException("Transfert annulé")
        // Persist progress and refresh the notification at most every PERSIST_MS, plus once
        // at completion so the final byte count is always stored.
        if (now - lastPersistMs >= PERSIST_MS || sent >= total) {
            lastPersistMs = now
            db.updateProgress(transferId, TransferState.RUNNING, sent)
            setProgressAsync(androidx.work.workDataOf("sent" to sent, "total" to total))
            if (canPostNotifications()) {
                NotificationManagerCompat.from(applicationContext).notify(notificationId, notification(name, sent, total, false))
            }
        }
    }

    private fun foreground(name: String, sent: Long, total: Long, done: Boolean) = ForegroundInfo(
        notificationId,
        notification(name, sent, total, done),
        if (android.os.Build.VERSION.SDK_INT >= 29) android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    )

    private fun notification(name: String, sent: Long, total: Long, done: Boolean): Notification {
        val cancel = PendingIntent.getBroadcast(
            applicationContext,
            notificationId,
            Intent(applicationContext, CancelTransferReceiver::class.java).putExtra(CancelTransferReceiver.EXTRA_TRANSFER_ID, transferId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val open = PendingIntent.getActivity(
            applicationContext,
            notificationId,
            Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val pct = if (total > 0) ((sent * 100L) / total).toInt().coerceIn(0, 100) else 0
        val ctx = applicationContext
        return NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (done) ctx.getString(R.string.notif_generic_title) else ctx.getString(R.string.notif_sending, name))
            .setContentText(if (done) name else ctx.getString(R.string.notif_progress, pct))
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(!done)
            .setProgress(100, pct, total <= 0)
            .addAction(0, ctx.getString(R.string.action_cancel), cancel)
            .build()
    }

    private fun notifyFinal(name: String, success: Boolean, text: String) {
        val open = PendingIntent.getActivity(
            applicationContext,
            notificationId,
            Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val ctx = applicationContext
        val line = ctx.getString(R.string.notif_result_line, name, text)
        // Item 7: post the outcome on the default-importance "results" channel so it is noticed.
        val n = NotificationCompat.Builder(ctx, CHANNEL_RESULTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (success) ctx.getString(R.string.notif_done_title) else ctx.getString(R.string.notif_failed_title))
            .setContentText(line)
            .setStyle(NotificationCompat.BigTextStyle().bigText(line))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        if (canPostNotifications()) NotificationManagerCompat.from(ctx).notify(notificationId, n)
    }

    private fun canPostNotifications(): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun userMessage(e: Exception): String = when (e) {
        is ApiException -> "HTTP ${e.status} — ${e.message}"
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun stableUploadId(id: String): String = id.replace("-", "").take(64)

    companion object {
        const val CHANNEL_ID = "direct_xfer_uploads"
        const val CHANNEL_RESULTS = "direct_xfer_results"
        const val KEY_TRANSFER_ID = "transfer_id"
        const val MAX_WORK_RETRIES = 10
        private const val PERSIST_MS = 500L
        private const val CANCEL_CHECK_MS = 1000L
        // Item 21: at most this many uploads transfer bytes concurrently.
        private const val MAX_CONCURRENT_UPLOADS = 2
        private val uploadGate = Semaphore(MAX_CONCURRENT_UPLOADS)
    }
}
