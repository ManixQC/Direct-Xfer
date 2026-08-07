package ca.manix123.directxfer.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import ca.manix123.directxfer.DirectXferApplication
import ca.manix123.directxfer.data.TransferState

class CancelTransferReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val transferId = intent.getStringExtra(EXTRA_TRANSFER_ID).orEmpty()
        if (transferId.isBlank()) return
        TransferScheduler.cancel(context, transferId)
        val app = context.applicationContext as DirectXferApplication
        val current = app.database.getTransfer(transferId) ?: return
        app.database.updateProgress(transferId, TransferState.CANCELLED, current.bytesSent, "Annulé par l’utilisateur")
    }

    companion object {
        const val EXTRA_TRANSFER_ID = "transfer_id"
    }
}
