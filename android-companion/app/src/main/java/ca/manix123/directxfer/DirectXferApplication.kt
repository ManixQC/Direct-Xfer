package ca.manix123.directxfer

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import ca.manix123.directxfer.data.CompanionDatabase
import ca.manix123.directxfer.work.TransferScheduler
import ca.manix123.directxfer.work.UploadWorker

class DirectXferApplication : Application() {
    val database: CompanionDatabase by lazy { CompanionDatabase(this) }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            // Low-importance channel for the ongoing progress notification.
            val progress = NotificationChannel(
                UploadWorker.CHANNEL_ID,
                getString(R.string.notification_channel_uploads),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.notification_channel_uploads_description)
                setShowBadge(true)
            }
            // Item 7: separate, default-importance channel so completion/failure is noticed.
            val results = NotificationChannel(
                UploadWorker.CHANNEL_RESULTS,
                getString(R.string.notification_channel_results),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = getString(R.string.notification_channel_results_description)
                setShowBadge(true)
            }
            manager.createNotificationChannel(progress)
            manager.createNotificationChannel(results)
        }
        // Reconcile the durable SQLite queue with WorkManager after process death,
        // an app update or a previous worker being stopped by Android.
        TransferScheduler.scheduleRecoveryWatchdog(this)
        TransferScheduler.kickRecovery(this)
    }
}
