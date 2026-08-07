package ca.manix123.directxfer.ui

import android.Manifest
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.OpenableColumns
import android.provider.Settings
import android.text.InputType
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.fragment.app.FragmentActivity
import ca.manix123.directxfer.BuildConfig
import ca.manix123.directxfer.DirectXferApplication
import ca.manix123.directxfer.LocaleHelper
import ca.manix123.directxfer.R
import ca.manix123.directxfer.data.Destination
import ca.manix123.directxfer.data.TransferMode
import ca.manix123.directxfer.data.TransferRecord
import ca.manix123.directxfer.data.TransferState
import ca.manix123.directxfer.net.DirectXferApi
import ca.manix123.directxfer.net.QrCodes
import ca.manix123.directxfer.security.SecureStore
import ca.manix123.directxfer.work.TransferScheduler
import java.io.File
import java.io.FileOutputStream
import java.util.Date
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Native reimplementation of the Direct-Xfer PWA look & feel: the exact dark palette
 * (pwa/app.css), a header with the logo + paired badge + network pill, a panel heading,
 * and a bottom navigation with the same four panels as the PWA — Envoyer / Images /
 * Activité / Réglages. The proven native engine (WorkManager queue, SQLite, resumable
 * uploads) is kept underneath so background transfers still work when the app is closed.
 */
class MainActivity : FragmentActivity() {
    private val app by lazy { application as DirectXferApplication }
    private val db by lazy { app.database }
    private val store by lazy { SecureStore(this) }
    private val api by lazy { DirectXferApi(store) }
    private val io = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var root: LinearLayout
    private lateinit var overlay: FrameLayout
    private lateinit var kicker: TextView
    private lateinit var summary: TextView
    private lateinit var pairedBadge: TextView
    private lateinit var networkPill: TextView
    private lateinit var panelHost: FrameLayout

    // Per-panel dynamic containers repopulated by refreshUi().
    private lateinit var sendConnection: TextView
    private lateinit var sendDestination: TextView
    private lateinit var sendQueue: LinearLayout
    private lateinit var sendPausedBanner: TextView
    private lateinit var sendPauseButton: Button
    private lateinit var imagesList: LinearLayout
    private lateinit var activityList: LinearLayout
    private lateinit var settingsConnection: TextView
    private val panels = HashMap<String, View>()
    private val navButtons = HashMap<String, LinearLayout>()
    private var currentPanel = "send"

    private var unlocked = false
    private var pendingIncoming: Intent? = null
    private var pendingShortcut: String? = null
    private var snackView: View? = null
    private val sampleBytes = HashMap<String, Long>()
    private val sampleTime = HashMap<String, Long>()
    @Volatile private var refreshing = false

    private val picker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) stageAndQueue(uris, uris.map { contentResolver.getType(it).orEmpty() }, forceImageLinks = false)
    }
    private val imagePicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) stageAndQueue(uris, uris.map { contentResolver.getType(it).orEmpty() }, forceImageLinks = true)
    }

    private val refreshRunnable = object : Runnable {
        override fun run() { refreshUi(); handler.postDelayed(this, 1500) }
    }

    override fun attachBaseContext(newBase: Context) { super.attachBaseContext(LocaleHelper.wrap(newBase)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        classifyIntent(intent)
        buildUi()
        selectPanel("send")
        requestNotificationPermission()
        if (store.biometricEnabled && store.isPaired()) authenticate { unlocked = true; consumePending() }
        else { unlocked = true; consumePending() }
        refreshUi()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (unlocked) { classifyIntent(intent); consumePending(); setIntent(Intent(this, MainActivity::class.java)) }
        else classifyIntent(intent)
    }

    override fun onResume() { super.onResume(); handler.post(refreshRunnable) }
    override fun onPause() { handler.removeCallbacks(refreshRunnable); super.onPause() }

    private fun classifyIntent(incoming: Intent) {
        when (incoming.action) {
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> pendingIncoming = incoming
            ACTION_PICK, ACTION_OPEN_PWA, ACTION_SETTINGS -> pendingShortcut = incoming.action
        }
    }

    // ---- UI construction -----------------------------------------------------

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }
        root.addView(buildHeader())
        root.addView(buildPanelHeading())

        panelHost = FrameLayout(this)
        panels["send"] = wrapScroll(buildSendPanel())
        panels["images"] = wrapScroll(buildImagesPanel())
        panels["activity"] = wrapScroll(buildActivityPanel())
        panels["settings"] = wrapScroll(buildSettingsPanel())
        panels.values.forEach { panelHost.addView(it, FrameLayout.LayoutParams(MATCH, MATCH)) }
        root.addView(panelHost, LinearLayout.LayoutParams(MATCH, 0, 1f))

        root.addView(buildBottomNav())

        overlay = FrameLayout(this)
        overlay.addView(root, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(overlay)
    }

    private fun buildHeader(): View {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(10))
        }
        header.addView(ImageView(this).apply {
            setImageResource(R.drawable.direct_xfer_icon)
            contentDescription = getString(R.string.cd_open_admin)
            setOnClickListener { openPwa() }
        }, LinearLayout.LayoutParams(dp(44), dp(44)))

        val titleBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0) }
        titleBox.addView(TextView(this).apply {
            text = getString(R.string.title_send)
            textSize = 22f; setTypeface(typeface, Typeface.BOLD); setTextColor(TEXT)
        })
        pairedBadge = TextView(this).apply {
            text = getString(R.string.paired_badge)
            textSize = 11f; setTextColor(ACCENT_2)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            background = pill(PANEL_2, BORDER)
            visibility = View.GONE
        }
        titleBox.addView(pairedBadge, LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(4) })
        header.addView(titleBox, LinearLayout.LayoutParams(0, WRAP, 1f))

        networkPill = TextView(this).apply {
            text = getString(R.string.network_online)
            textSize = 12f; setTextColor(MUTED)
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = pill(PANEL_2, BORDER)
        }
        header.addView(networkPill)
        return header
    }

    private fun buildPanelHeading(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(4), dp(18), dp(10))
        }
        kicker = TextView(this).apply {
            text = getString(R.string.nav_send)
            textSize = 12f; setTextColor(FAINT); letterSpacing = 0.08f
            setTypeface(typeface, Typeface.BOLD)
        }
        summary = TextView(this).apply {
            text = getString(R.string.nav_send_hint)
            textSize = 14f; setTextColor(MUTED); setPadding(0, dp(2), 0, 0)
        }
        box.addView(kicker); box.addView(summary)
        return box
    }

    private fun buildBottomNav(): View {
        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = ContextCompat.getDrawable(context, R.drawable.bg_navbar)
            setPadding(dp(6), dp(6), dp(6), dp(8))
        }
        data class Item(val id: String, val glyph: String, val label: String)
        val items = listOf(
            Item("send", "⇧", getString(R.string.nav_send)),
            Item("images", "▧", getString(R.string.nav_images)),
            Item("activity", "◷", getString(R.string.nav_activity)),
            Item("settings", "⚙", getString(R.string.nav_settings))
        )
        items.forEach { item ->
            val cell = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(4), dp(6), dp(4), dp(4))
                isClickable = true; isFocusable = true
                setOnClickListener { selectPanel(item.id) }
            }
            cell.addView(TextView(this).apply { text = item.glyph; textSize = 20f; gravity = Gravity.CENTER })
            cell.addView(TextView(this).apply { text = item.label; textSize = 11f; gravity = Gravity.CENTER; setPadding(0, dp(2), 0, 0) })
            navButtons[item.id] = cell
            nav.addView(cell, LinearLayout.LayoutParams(0, WRAP, 1f).apply { marginStart = dp(2); marginEnd = dp(2) })
        }
        return nav
    }

    private fun selectPanel(id: String) {
        currentPanel = id
        panels.forEach { (key, view) -> view.visibility = if (key == id) View.VISIBLE else View.GONE }
        navButtons.forEach { (key, cell) ->
            val active = key == id
            cell.background = if (active) ContextCompat.getDrawable(this, R.drawable.bg_nav_active) else null
            val color = if (active) ACCENT_2 else FAINT
            (cell.getChildAt(0) as TextView).setTextColor(color)
            (cell.getChildAt(1) as TextView).setTextColor(color)
        }
        when (id) {
            "send" -> heading(R.string.nav_send, R.string.nav_send_hint)
            "images" -> heading(R.string.nav_images, R.string.nav_images_hint)
            "activity" -> heading(R.string.nav_activity, R.string.nav_activity_hint)
            "settings" -> heading(R.string.nav_settings, R.string.nav_settings_hint)
        }
        refreshUi()
    }

    private fun heading(labelRes: Int, hintRes: Int) {
        kicker.text = getString(labelRes); summary.text = getString(hintRes)
    }

    // ---- Panels --------------------------------------------------------------

    private fun buildSendPanel(): View {
        val col = column()

        val destCard = card()
        destCard.addView(cardLabel(getString(R.string.section_destination)))
        sendDestination = cardValue(getString(R.string.no_destination))
        destCard.addView(sendDestination)
        destCard.addView(row(
            ghostButton(getString(R.string.btn_add)) { showDestinationDialog() },
            ghostButton(getString(R.string.btn_choose)) { showDestinationManager() }
        ))
        col.addView(destCard)

        val filesCard = card()
        filesCard.addView(cardLabel(getString(R.string.section_files)))
        filesCard.addView(row(
            primaryButton(getString(R.string.btn_pick_files)) { picker.launch(arrayOf("*/*")) },
            ghostButton(getString(R.string.btn_pick_camera)) { imagePicker.launch(arrayOf("image/*")) }
        ))
        col.addView(filesCard)

        val queueCard = card()
        queueCard.addView(cardLabel(getString(R.string.section_queue)))
        sendPausedBanner = TextView(this).apply {
            text = getString(R.string.paused_banner); setTextColor(DANGER)
            setPadding(0, dp(2), 0, dp(6)); visibility = View.GONE
        }
        queueCard.addView(sendPausedBanner)
        sendPauseButton = ghostButton(getString(R.string.btn_pause_all)) { togglePauseAll() }
        queueCard.addView(row(
            ghostButton(getString(R.string.btn_clear_finished)) { clearFinished() },
            sendPauseButton
        ))
        sendQueue = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(4), 0, 0) }
        queueCard.addView(sendQueue)
        col.addView(queueCard)

        sendConnection = TextView(this).apply { visibility = View.GONE }
        return col
    }

    private fun buildImagesPanel(): View {
        val col = column()
        val head = card()
        head.addView(cardLabel(getString(R.string.images_title)))
        head.addView(cardSub(getString(R.string.images_hint)))
        head.addView(primaryButton(getString(R.string.btn_pick_image_links)) { imagePicker.launch(arrayOf("image/*")) })
        col.addView(head)

        val lib = card()
        lib.addView(cardLabel(getString(R.string.images_library)))
        imagesList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(4), 0, 0) }
        lib.addView(imagesList)
        col.addView(lib)
        return col
    }

    private fun buildActivityPanel(): View {
        val col = column()
        val c = card()
        c.addView(cardLabel(getString(R.string.activity_title)))
        c.addView(ghostButton(getString(R.string.btn_clear_finished)) { clearFinished() })
        activityList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(6), 0, 0) }
        c.addView(activityList)
        col.addView(c)
        return col
    }

    private fun buildSettingsPanel(): View {
        val col = column()

        val security = card()
        security.addView(cardLabel(getString(R.string.group_security)))
        settingsConnection = cardValue(getString(R.string.not_connected))
        security.addView(settingsConnection)
        security.addView(row(
            primaryButton(getString(R.string.btn_connect)) { showLoginDialog() },
            ghostButton(getString(R.string.btn_test_connection)) { testConnection() }
        ))
        security.addView(checkbox(getString(R.string.opt_biometric), store.biometricEnabled) { checked ->
            if (checked && !store.biometricEnabled) authenticate { store.biometricEnabled = true; refreshCheckboxes() }
            else if (!checked) store.biometricEnabled = false
        })
        security.addView(dangerButton(getString(R.string.btn_revoke)) { revokeDevice() })
        col.addView(security)

        val images = card()
        images.addView(cardLabel(getString(R.string.group_images)))
        images.addView(checkbox(getString(R.string.opt_image_links), store.defaultImageLinks) { store.defaultImageLinks = it })
        images.addView(checkbox(getString(R.string.opt_clean_exif), store.cleanExif) { store.cleanExif = it })
        images.addView(ghostButton(getString(R.string.btn_image_settings)) { showImageSettingsDialog() })
        col.addView(images)

        val network = card()
        network.addView(cardLabel(getString(R.string.group_network)))
        network.addView(checkbox(getString(R.string.opt_wifi_only), store.wifiOnly) { store.wifiOnly = it })
        network.addView(ghostButton(getString(R.string.btn_battery)) { requestBatteryExemption() })
        col.addView(network)

        val appearance = card()
        appearance.addView(cardLabel(getString(R.string.group_appearance)))
        appearance.addView(row(
            ghostButton(getString(R.string.btn_language)) { showLanguageDialog() },
            ghostButton(getString(R.string.btn_open_pwa)) { openPwa() }
        ))
        col.addView(appearance)

        col.addView(TextView(this).apply {
            text = getString(R.string.version_footer, BuildConfig.VERSION_NAME)
            textSize = 12f; setTextColor(FAINT); gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, dp(10), 0, dp(4))
        })
        return col
    }

    private var settingsCheckboxes = mutableListOf<CheckBox>()
    private fun refreshCheckboxes() {
        settingsCheckboxes.forEach { cb ->
            when (cb.tag) {
                "bio" -> cb.isChecked = store.biometricEnabled
                "img" -> cb.isChecked = store.defaultImageLinks
                "exif" -> cb.isChecked = store.cleanExif
                "wifi" -> cb.isChecked = store.wifiOnly
            }
        }
    }

    // ---- Refresh -------------------------------------------------------------

    private fun refreshUi() {
        if (refreshing) return
        refreshing = true
        io.execute {
            val paired: Boolean; val serverUrl: String?; val selected: Destination?
            val records: List<TransferRecord>; val paused: Boolean
            try {
                paired = store.isPaired(); serverUrl = store.serverUrl
                selected = db.selectedDestination(); records = db.listTransfers(80); paused = store.pausedAll
            } catch (_: Exception) { runOnUiThread { refreshing = false }; return@execute }
            runOnUiThread {
                refreshing = false
                pairedBadge.visibility = if (paired) View.VISIBLE else View.GONE
                networkPill.text = getString(if (isOnline()) R.string.network_online else R.string.network_offline)
                networkPill.setTextColor(if (isOnline()) OK else WARN)
                val connText = if (paired) getString(R.string.connected, serverUrl) else getString(R.string.not_connected)
                settingsConnection.text = connText
                sendDestination.text = selected?.let { "${it.name}\n${it.serverUrl}/u/${it.token}" } ?: getString(R.string.no_destination)
                sendPausedBanner.visibility = if (paused) View.VISIBLE else View.GONE
                sendPauseButton.text = getString(if (paused) R.string.btn_resume_all else R.string.btn_pause_all)

                val active = records.filter { it.state == TransferState.QUEUED || it.state == TransferState.RUNNING }
                val terminal = records.filter { it.state == TransferState.SUCCESS || it.state == TransferState.FAILED || it.state == TransferState.CANCELLED }
                val imageLinks = records.filter { it.mode == TransferMode.IMAGE_LINK && !it.resultUrl.isNullOrBlank() }

                fill(sendQueue, active, R.string.queue_empty)
                fill(activityList, terminal, R.string.activity_empty)
                fill(imagesList, imageLinks, R.string.images_empty)
            }
        }
    }

    private fun fill(container: LinearLayout, list: List<TransferRecord>, emptyRes: Int) {
        container.removeAllViews()
        if (list.isEmpty()) { container.addView(cardSub(getString(emptyRes))); return }
        list.forEach { container.addView(transferCard(it)) }
    }

    private fun transferCard(r: TransferRecord): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = ContextCompat.getDrawable(context, R.drawable.bg_card_inset)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        card.addView(TextView(this).apply { text = r.displayName; textSize = 15f; setTextColor(TEXT); setTypeface(typeface, Typeface.BOLD) })
        val percent = if (r.bytesTotal > 0) ((r.bytesSent * 100) / r.bytesTotal).coerceIn(0, 100).toInt() else 0
        card.addView(TextView(this).apply {
            text = getString(R.string.card_meta, stateLabel(r.state), percent, formatBytes(r.bytesTotal), r.attempts)
            textSize = 13f; setTextColor(stateColor(r.state)); setPadding(0, dp(2), 0, 0)
        })
        val modeLine = if (r.mode == TransferMode.IMAGE_LINK) getString(R.string.card_mode_image)
        else getString(R.string.card_mode_reception, r.destinationName ?: getString(R.string.detail_none))
        card.addView(cardSub(modeLine))
        speedEta(r)?.let { card.addView(cardSub(it)) }
        r.error?.let { card.addView(TextView(this).apply { text = it; textSize = 12f; setTextColor(DANGER); setPadding(0, dp(2), 0, 0) }) }

        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100; progress = percent
            progressTintList = android.content.res.ColorStateList.valueOf(ACCENT)
        }
        card.addView(bar, LinearLayout.LayoutParams(MATCH, dp(6)).apply { topMargin = dp(8) })

        val buttons = FlowButtons()
        if (r.state == TransferState.RUNNING || r.state == TransferState.QUEUED)
            buttons.add(ghostSm(getString(R.string.action_cancel)) { TransferScheduler.cancel(this, r.id) })
        if (r.state == TransferState.QUEUED)
            buttons.add(ghostSm(getString(R.string.btn_prioritize)) { prioritize(r.id) })
        if (r.state == TransferState.FAILED || r.state == TransferState.CANCELLED)
            buttons.add(ghostSm(getString(R.string.btn_retry)) { TransferScheduler.retry(this, r.id) })
        r.resultUrl?.let { url ->
            if (r.mode == TransferMode.IMAGE_LINK) {
                buttons.add(ghostSm(getString(R.string.btn_copy_full)) { copy(url) })
                variantUrl(url, "thumb")?.let { m -> buttons.add(ghostSm(getString(R.string.btn_copy_mini)) { copy(m) }) }
                variantUrl(url, "micro")?.let { m -> buttons.add(ghostSm(getString(R.string.btn_copy_micro)) { copy(m) }) }
            } else {
                buttons.add(ghostSm(getString(R.string.btn_copy_link)) { copy(url) })
            }
            buttons.add(ghostSm(getString(R.string.btn_qr)) { showQr(url, r.displayName) })
            buttons.add(ghostSm(getString(R.string.btn_open_link)) { openUrl(url) })
            buttons.add(ghostSm(getString(R.string.btn_share)) { shareText(url) })
        }
        buttons.add(ghostSm(getString(R.string.btn_details)) { showTransferDetail(r) })
        if (r.state == TransferState.SUCCESS || r.state == TransferState.FAILED || r.state == TransferState.CANCELLED)
            buttons.add(dangerSm(getString(R.string.btn_remove)) {
                File(r.filePath).parentFile?.deleteRecursively(); io.execute { db.deleteTransfer(r.id) }
            })
        card.addView(buttons.view)

        return LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(card); setPadding(0, 0, 0, dp(10)) }
    }

    private fun speedEta(r: TransferRecord): String? {
        if (r.state != TransferState.RUNNING) { sampleBytes.remove(r.id); sampleTime.remove(r.id); return null }
        val now = SystemClock.elapsedRealtime()
        val prevB = sampleBytes[r.id]; val prevT = sampleTime[r.id]
        sampleBytes[r.id] = r.bytesSent; sampleTime[r.id] = now
        if (prevB == null || prevT == null || now <= prevT) return null
        val delta = r.bytesSent - prevB; if (delta <= 0) return null
        val bps = delta * 1000L / (now - prevT); if (bps <= 0) return null
        val remain = (r.bytesTotal - r.bytesSent).coerceAtLeast(0L)
        return getString(R.string.card_speed_eta, formatBytes(bps) + "/s", formatDuration(remain / bps))
    }

    // ---- Actions (reused engine) --------------------------------------------

    private fun prioritize(id: String) {
        io.execute { db.prioritize(id); TransferScheduler.enqueue(this, id, replace = true); runOnUiThread { toast(getString(R.string.toast_prioritized)); refreshUi() } }
    }
    private fun clearFinished() {
        io.execute { val paths = db.deleteFinishedTransfers(); paths.forEach { File(it).parentFile?.deleteRecursively() }; runOnUiThread { toast(getString(R.string.toast_cleared, paths.size)); refreshUi() } }
    }
    private fun togglePauseAll() {
        io.execute {
            val nowPaused = !store.pausedAll
            if (nowPaused) TransferScheduler.pauseAll(this) else TransferScheduler.resumeAll(this)
            runOnUiThread { toast(getString(if (nowPaused) R.string.toast_paused_all else R.string.toast_resumed_all)); refreshUi() }
        }
    }

    private fun showLoginDialog() {
        val box = dialogColumn()
        val server = styledEdit(getString(R.string.hint_server), store.serverUrl ?: getString(R.string.default_server))
        val user = styledEdit(getString(R.string.hint_username), "")
        val pass = styledEdit(getString(R.string.hint_password), "", password = true)
        val totp = styledEdit(getString(R.string.hint_totp), "")
        listOf(server, user, pass, totp).forEach { box.addView(it) }
        val dialog = themedDialog().setTitle(getString(R.string.dlg_login_title)).setView(box)
            .setNegativeButton(getString(R.string.action_cancel), null)
            .setPositiveButton(getString(R.string.btn_login), null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val btn = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                btn.isEnabled = false; btn.text = getString(R.string.btn_login_progress)
                io.execute {
                    try {
                        val result = api.login(server.text.toString(), user.text.toString(), pass.text.toString(), totp.text.toString(), "Direct-Xfer Android — ${Build.MODEL}")
                        store.serverUrl = result.server; store.deviceToken = result.token; store.csrf = result.csrf
                        runOnUiThread { dialog.dismiss(); toast(getString(R.string.toast_paired)); refreshUi() }
                    } catch (e: Exception) {
                        runOnUiThread { btn.isEnabled = true; btn.text = getString(R.string.btn_login); toast(getString(R.string.toast_login_failed, e.message ?: "")) }
                    }
                }
            }
        }
        dialog.show()
    }

    private fun showDestinationDialog() {
        val box = dialogColumn()
        val name = styledEdit(getString(R.string.hint_dest_name), getString(R.string.default_dest_name))
        val link = styledEdit(getString(R.string.hint_dest_link), "")
        box.addView(name); box.addView(link)
        themedDialog().setTitle(getString(R.string.dlg_add_destination_title)).setView(box)
            .setNegativeButton(getString(R.string.action_cancel), null)
            .setPositiveButton(getString(R.string.btn_add)) { _, _ ->
                try {
                    val parsed = DirectXferApi.parseReceptionLink(link.text.toString(), store.serverUrl)
                    val id = db.upsertDestination(name.text.toString().ifBlank { getString(R.string.default_dest_name) }, parsed.second, parsed.first)
                    db.selectDestination(id); refreshUi()
                } catch (e: Exception) { toast(e.message ?: getString(R.string.toast_invalid_link)) }
            }.show()
    }

    private fun showDestinationManager() {
        if (db.listDestinations().isEmpty()) { showDestinationDialog(); return }
        val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(4), dp(16), dp(4)) }
        val dialog = themedDialog().setTitle(getString(R.string.dlg_choose_destination_title))
            .setView(ScrollView(this).apply { addView(container) })
            .setNeutralButton(getString(R.string.btn_add), null)
            .setNegativeButton(getString(R.string.btn_close), null).create()
        fun populate() {
            container.removeAllViews()
            db.listDestinations().forEach { d ->
                container.addView(TextView(this).apply {
                    text = (if (d.selected) getString(R.string.badge_selected) else "") + d.name
                    textSize = 16f; setTextColor(TEXT); setPadding(0, dp(10), 0, 0)
                })
                container.addView(cardSub("${d.serverUrl}/u/${d.token}"))
                container.addView(row(
                    ghostSm(getString(R.string.btn_choose)) { db.selectDestination(d.id); refreshUi(); dialog.dismiss() },
                    ghostSm(getString(R.string.btn_rename)) { renameDestination(d) { populate() } },
                    dangerSm(getString(R.string.btn_delete)) { db.deleteDestination(d.id); refreshUi(); populate() }
                ))
            }
        }
        populate()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { dialog.dismiss(); showDestinationDialog() } }
        dialog.show()
    }

    private fun renameDestination(d: Destination, after: () -> Unit) {
        val input = styledEdit(getString(R.string.hint_dest_name), d.name)
        themedDialog().setTitle(getString(R.string.dlg_rename_destination_title)).setView(dialogColumn().apply { addView(input) })
            .setNegativeButton(getString(R.string.action_cancel), null)
            .setPositiveButton(getString(R.string.btn_save)) { _, _ -> db.renameDestination(d.id, input.text.toString().ifBlank { d.name }); after(); refreshUi() }.show()
    }

    private fun showImageSettingsDialog() {
        val box = dialogColumn()
        val full = numberField(getString(R.string.lbl_full_max), store.imageFullMax)
        val thumb = numberField(getString(R.string.lbl_thumb_max), store.imageThumbMax)
        val micro = numberField(getString(R.string.lbl_micro_max), store.imageMicroMax)
        val quality = numberField(getString(R.string.lbl_jpeg_quality), store.imageQuality)
        listOf(full, thumb, micro, quality).forEach { box.addView(it.first); box.addView(it.second) }
        themedDialog().setTitle(getString(R.string.dlg_image_settings_title)).setView(ScrollView(this).apply { addView(box) })
            .setNegativeButton(getString(R.string.action_cancel), null)
            .setPositiveButton(getString(R.string.btn_save)) { _, _ ->
                full.second.text.toString().toIntOrNull()?.let { store.imageFullMax = it }
                thumb.second.text.toString().toIntOrNull()?.let { store.imageThumbMax = it }
                micro.second.text.toString().toIntOrNull()?.let { store.imageMicroMax = it }
                quality.second.text.toString().toIntOrNull()?.let { store.imageQuality = it }
            }.show()
    }

    private fun showLanguageDialog() {
        val codes = arrayOf<String?>(null, "fr", "en", "es")
        val labels = arrayOf(getString(R.string.lang_system), getString(R.string.lang_fr), getString(R.string.lang_en), getString(R.string.lang_es))
        val checked = codes.indexOfFirst { it == store.language }.coerceAtLeast(0)
        themedDialog().setTitle(getString(R.string.dlg_language_title))
            .setSingleChoiceItems(labels, checked) { d, which -> store.language = codes[which]; d.dismiss(); recreate() }
            .setNegativeButton(getString(R.string.btn_close), null).show()
    }

    private fun requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) { toast(getString(R.string.battery_unsupported)); return }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) { toast(getString(R.string.battery_already)); return }
        try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
        catch (_: Exception) { try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) { toast(getString(R.string.battery_unsupported)) } }
    }

    private fun showQr(url: String, name: String) {
        val box = dialogColumn()
        QrCodes.bitmap(url, dp(240))?.let { bmp ->
            box.addView(ImageView(this).apply { setImageBitmap(bmp); contentDescription = getString(R.string.cd_qr) }, LinearLayout.LayoutParams(dp(240), dp(240)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        }
        box.addView(cardSub(url))
        themedDialog().setTitle(name).setView(box).setPositiveButton(getString(R.string.btn_close), null).show()
    }

    private fun showTransferDetail(r: TransferRecord) {
        val box = dialogColumn()
        fun rowd(labelRes: Int, value: String?) {
            box.addView(TextView(this).apply { text = getString(labelRes); textSize = 12f; setTextColor(FAINT); setPadding(0, dp(8), 0, 0) })
            box.addView(TextView(this).apply { text = value?.takeIf { it.isNotBlank() } ?: getString(R.string.detail_none); textSize = 15f; setTextColor(TEXT) })
        }
        val mode = if (r.mode == TransferMode.IMAGE_LINK) getString(R.string.card_mode_image) else getString(R.string.card_mode_reception, r.destinationName ?: getString(R.string.detail_none))
        rowd(R.string.detail_name, r.displayName); rowd(R.string.detail_mode, mode)
        r.destinationServer?.let { rowd(R.string.detail_destination, "$it/u/${r.destinationToken}") }
        rowd(R.string.detail_state, stateLabel(r.state)); rowd(R.string.detail_size, formatBytes(r.bytesTotal))
        rowd(R.string.detail_sent, formatBytes(r.bytesSent)); rowd(R.string.detail_attempts, r.attempts.toString())
        rowd(R.string.detail_created, formatDate(r.createdAt)); rowd(R.string.detail_updated, formatDate(r.updatedAt))
        r.error?.let { rowd(R.string.detail_error, it) }
        r.resultUrl?.let { url ->
            rowd(R.string.detail_link, url)
            QrCodes.bitmap(url, dp(220))?.let { bmp ->
                box.addView(ImageView(this).apply { setImageBitmap(bmp); contentDescription = getString(R.string.cd_qr); setPadding(0, dp(12), 0, dp(4)) }, LinearLayout.LayoutParams(dp(220), dp(220)).apply { topMargin = dp(12); gravity = Gravity.CENTER_HORIZONTAL })
            }
        }
        themedDialog().setTitle(getString(R.string.dlg_detail_title)).setView(ScrollView(this).apply { addView(box) }).setPositiveButton(getString(R.string.btn_close), null).show()
    }

    private fun consumePending() {
        pendingShortcut?.let { action ->
            pendingShortcut = null
            when (action) {
                ACTION_PICK -> picker.launch(arrayOf("*/*"))
                ACTION_OPEN_PWA -> openPwa()
                ACTION_SETTINGS -> selectPanel("settings")
            }
        }
        val incoming = pendingIncoming ?: return
        pendingIncoming = null
        processIncoming(incoming)
        setIntent(Intent(this, MainActivity::class.java))
    }

    private fun processIncoming(incoming: Intent) {
        val text = incoming.getStringExtra(Intent.EXTRA_TEXT)
        if (!text.isNullOrBlank() && text.contains("/u/")) {
            try {
                val parsed = DirectXferApi.parseReceptionLink(text, store.serverUrl)
                val id = db.upsertDestination(getString(R.string.shared_destination_name), parsed.second, parsed.first)
                db.selectDestination(id); toast(getString(R.string.toast_destination_added))
            } catch (_: Exception) {}
        }
        val uris = when (incoming.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(incoming, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(incoming, Intent.EXTRA_STREAM, Uri::class.java)?.toList().orEmpty()
            else -> emptyList()
        }
        if (uris.isNotEmpty()) stageAndQueue(uris, uris.map { contentResolver.getType(it) ?: incoming.type.orEmpty() }, forceImageLinks = false)
    }

    private fun stageAndQueue(uris: List<Uri>, mimeTypes: List<String>, forceImageLinks: Boolean) {
        val allImages = uris.indices.all { mimeTypes.getOrNull(it)?.startsWith("image/") == true }
        if ((forceImageLinks || (allImages && store.defaultImageLinks)) && !store.isPaired()) {
            toast(getString(R.string.toast_connect_first_images)); selectPanel("settings"); showLoginDialog(); return
        }
        val mode = if ((forceImageLinks || (allImages && store.defaultImageLinks)) && allImages) TransferMode.IMAGE_LINK else TransferMode.RECEPTION
        val destination = if (mode == TransferMode.RECEPTION) db.selectedDestination() else null
        if (mode == TransferMode.RECEPTION && destination == null) { toast(getString(R.string.toast_add_reception_first)); selectPanel("send"); showDestinationDialog(); return }
        toast(getString(R.string.toast_preparing, uris.size))
        io.execute {
            var added = 0
            uris.forEachIndexed { index, uri ->
                try {
                    val meta = metadata(uri, index)
                    val id = UUID.randomUUID().toString()
                    val dir = File(filesDir, "outbox/$id").apply { mkdirs() }
                    val file = File(dir, sanitize(meta.first))
                    contentResolver.openInputStream(uri)?.use { input -> FileOutputStream(file).use { input.copyTo(it, 128 * 1024) } } ?: error(getString(R.string.toast_cannot_read, uri.toString()))
                    val now = System.currentTimeMillis()
                    db.insertTransfer(TransferRecord(
                        id = id, filePath = file.absolutePath, displayName = meta.first,
                        mimeType = mimeTypes.getOrNull(index).orEmpty().ifBlank { "application/octet-stream" },
                        bytesTotal = file.length(), bytesSent = 0, mode = mode,
                        destinationToken = destination?.token, destinationName = destination?.name, destinationServer = destination?.serverUrl,
                        cleanExif = store.cleanExif, state = TransferState.QUEUED, resultUrl = null, error = null, createdAt = now, updatedAt = now
                    ))
                    TransferScheduler.enqueue(this, id); added++
                } catch (e: Exception) { runOnUiThread { toast(getString(R.string.toast_error, e.message ?: "")) } }
            }
            runOnUiThread { toast(getString(R.string.toast_added, added)); selectPanel(if (mode == TransferMode.IMAGE_LINK) "images" else "send"); refreshUi() }
        }
    }

    private fun metadata(uri: Uri, index: Int): Pair<String, Long> {
        var name = "fichier-${index + 1}"; var size = 0L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                val si = c.getColumnIndex(OpenableColumns.SIZE); if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
            }
        }
        return name to size
    }

    private fun testConnection() {
        if (!store.isPaired()) { showLoginDialog(); return }
        io.execute {
            try { val s = api.status(); runOnUiThread { toast(getString(R.string.toast_connection_ok, s.optJSONObject("device")?.optString("name") ?: getString(R.string.device_default))) } }
            catch (e: Exception) { runOnUiThread { toast(getString(R.string.toast_login_failed, e.message ?: "")) } }
        }
    }

    private fun revokeDevice() {
        if (!store.isPaired()) return
        themedDialog().setTitle(getString(R.string.dlg_revoke_title)).setMessage(getString(R.string.dlg_revoke_message))
            .setNegativeButton(getString(R.string.action_cancel), null)
            .setPositiveButton(getString(R.string.btn_revoke_confirm)) { _, _ ->
                io.execute { try { api.revokeThisDevice(false) } catch (_: Exception) {}; store.clearCredentials(); runOnUiThread { refreshUi(); toast(getString(R.string.toast_revoked)) } }
            }.show()
    }

    private fun openPwa() { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${store.serverUrl ?: getString(R.string.default_server)}/app/launch"))) }
    private fun openUrl(url: String) { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {} }

    private fun authenticate(onSuccess: () -> Unit) {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (BiometricManager.from(this).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) { store.biometricEnabled = false; onSuccess(); return }
        root.alpha = 0.3f
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { root.alpha = 1f; onSuccess() }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { if (!unlocked) finish() else { root.alpha = 1f; refreshCheckboxes() } }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(getString(R.string.app_name)).setSubtitle(getString(R.string.opt_biometric)).setAllowedAuthenticators(authenticators).build())
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
    }

    // ---- Styled component helpers -------------------------------------------

    private fun wrapScroll(content: View) = ScrollView(this).apply {
        isFillViewport = true
        addView(content, ViewGroup.LayoutParams(MATCH, WRAP))
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(4), dp(16), dp(20)) }
    private fun dialogColumn() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0) }
    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = ContextCompat.getDrawable(context, R.drawable.bg_card)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(14) }
    }
    private fun cardLabel(text: String) = TextView(this).apply {
        this.text = text.uppercase(); textSize = 12f; setTextColor(FAINT); letterSpacing = 0.06f
        setTypeface(typeface, Typeface.BOLD); setPadding(0, 0, 0, dp(8))
    }
    private fun cardValue(text: String) = TextView(this).apply { this.text = text; textSize = 15f; setTextColor(TEXT); setPadding(0, 0, 0, dp(10)) }
    private fun cardSub(text: String) = TextView(this).apply { this.text = text; textSize = 13f; setTextColor(MUTED); setPadding(0, dp(2), 0, dp(4)) }

    private fun baseButton(text: String, bg: Int, fg: Int, onClick: () -> Unit) = Button(this).apply {
        this.text = text; isAllCaps = false; setTextColor(fg); textSize = 15f
        background = ContextCompat.getDrawable(context, bg); minHeight = dp(48); minimumHeight = dp(48)
        stateListAnimator = null; setPadding(dp(14), dp(10), dp(14), dp(10))
        setOnClickListener { onClick() }
    }
    private fun primaryButton(text: String, onClick: () -> Unit) = baseButton(text, R.drawable.btn_primary, Color.WHITE, onClick)
    private fun ghostButton(text: String, onClick: () -> Unit) = baseButton(text, R.drawable.btn_ghost, TEXT, onClick)
    private fun dangerButton(text: String, onClick: () -> Unit) = baseButton(text, R.drawable.btn_danger, DANGER, onClick)
    private fun ghostSm(text: String, onClick: () -> Unit) = baseButton(text, R.drawable.btn_ghost, TEXT, onClick).apply { textSize = 13f; minHeight = dp(40); minimumHeight = dp(40) }
    private fun dangerSm(text: String, onClick: () -> Unit) = baseButton(text, R.drawable.btn_danger, DANGER, onClick).apply { textSize = 13f; minHeight = dp(40); minimumHeight = dp(40) }

    private fun row(vararg views: View): LinearLayout {
        val r = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(4), 0, 0) }
        views.forEachIndexed { i, v -> r.addView(v, LinearLayout.LayoutParams(0, WRAP, 1f).apply { if (i > 0) marginStart = dp(8) }) }
        return r
    }

    /** Wrap-friendly button container: two per row so long action sets don't overflow. */
    private inner class FlowButtons {
        val view = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(8), 0, 0) }
        private var currentRow: LinearLayout? = null
        private var inRow = 0
        fun add(button: View) {
            if (currentRow == null || inRow == 2) {
                currentRow = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(4), 0, 0) }
                view.addView(currentRow); inRow = 0
            }
            currentRow!!.addView(button, LinearLayout.LayoutParams(0, WRAP, 1f).apply { if (inRow > 0) marginStart = dp(8) }); inRow++
        }
    }

    private fun checkbox(text: String, checked: Boolean, onChange: (Boolean) -> Unit) = CheckBox(this).apply {
        this.text = text; isChecked = checked; setTextColor(TEXT); setPadding(dp(6), dp(8), 0, dp(8))
        buttonTintList = android.content.res.ColorStateList.valueOf(ACCENT)
        tag = when {
            text == getString(R.string.opt_biometric) -> "bio"; text == getString(R.string.opt_image_links) -> "img"
            text == getString(R.string.opt_clean_exif) -> "exif"; text == getString(R.string.opt_wifi_only) -> "wifi"; else -> ""
        }
        settingsCheckboxes.add(this)
        setOnCheckedChangeListener { _, isChecked -> onChange(isChecked) }
    }

    private fun styledEdit(hintValue: String, value: String, password: Boolean = false) = EditText(this).apply {
        hint = hintValue; setText(value); setSingleLine(true)
        setTextColor(TEXT); setHintTextColor(FAINT)
        background = ContextCompat.getDrawable(context, R.drawable.bg_input)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) }
    }

    private fun numberField(labelValue: String, value: Int): Pair<TextView, EditText> {
        val lbl = TextView(this).apply { text = labelValue; textSize = 13f; setTextColor(MUTED); setPadding(0, dp(10), 0, 0) }
        val field = styledEdit("", value.toString()).apply { inputType = InputType.TYPE_CLASS_NUMBER }
        return lbl to field
    }

    private fun themedDialog() = AlertDialog.Builder(this, R.style.Theme_DirectXfer_Dialog)

    private fun pill(fill: Int, border: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; cornerRadius = dp(999).toFloat(); setColor(fill); setStroke(dp(1), border)
    }

    // ---- Snackbar / util -----------------------------------------------------

    private fun toast(message: String) {
        snackView?.let { overlay.removeView(it) }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(PANEL_2); setStroke(dp(1), BORDER) }
            setPadding(dp(16), dp(12), dp(16), dp(12)); elevation = dp(8).toFloat()
        }
        bar.addView(TextView(this).apply { text = message; setTextColor(TEXT); textSize = 14f }, LinearLayout.LayoutParams(0, WRAP, 1f))
        overlay.addView(bar, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM).apply { setMargins(dp(10), dp(10), dp(10), dp(78)) })
        snackView = bar
        handler.postDelayed({ if (snackView === bar) { overlay.removeView(bar); snackView = null } }, 3800)
    }

    private fun copy(value: String) { (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Direct-Xfer", value)); toast(getString(R.string.toast_copied)) }
    private fun shareText(value: String) { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, value) }, getString(R.string.chooser_share_link))) }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        return cm.activeNetwork != null
    }

    /** Build a Mini/Micro link from a Full image URL (…/i/<token>.<ext> → …/i/<token>/<variant>). */
    private fun variantUrl(fullUrl: String, variant: String): String? {
        val m = Regex("^(.*/i/[A-Za-z0-9_-]+)(\\.[A-Za-z0-9]+)?$").find(fullUrl) ?: return null
        return m.groupValues[1] + "/" + variant
    }

    private fun stateLabel(state: TransferState) = when (state) {
        TransferState.QUEUED -> getString(R.string.state_queued); TransferState.RUNNING -> getString(R.string.state_running)
        TransferState.SUCCESS -> getString(R.string.state_success); TransferState.FAILED -> getString(R.string.state_failed); TransferState.CANCELLED -> getString(R.string.state_cancelled)
    }
    private fun stateColor(state: TransferState) = when (state) {
        TransferState.SUCCESS -> OK; TransferState.FAILED -> DANGER; TransferState.CANCELLED -> WARN; else -> MUTED
    }
    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024L * 1024L -> "%.2f Go".format(bytes / (1024.0 * 1024.0 * 1024.0))
        bytes >= 1024L * 1024L -> "%.1f Mo".format(bytes / (1024.0 * 1024.0))
        bytes >= 1024L -> "%.1f Ko".format(bytes / 1024.0)
        else -> "$bytes o"
    }
    private fun formatDuration(seconds: Long): String = when {
        seconds < 0 -> "—"; seconds >= 3600 -> "%dh%02d".format(seconds / 3600, (seconds % 3600) / 60)
        seconds >= 60 -> "%dmin".format(seconds / 60); else -> "${seconds}s"
    }
    private fun formatDate(ms: Long): String = if (ms <= 0) getString(R.string.detail_none)
    else DateFormat.getDateFormat(this).format(Date(ms)) + " " + DateFormat.getTimeFormat(this).format(Date(ms))
    private fun sanitize(name: String) = name.replace(Regex("[\\r\\n\\t/\\\\]+"), "_").take(180).ifBlank { "fichier" }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val ACTION_PICK = "ca.manix123.directxfer.action.PICK"
        const val ACTION_OPEN_PWA = "ca.manix123.directxfer.action.OPEN_PWA"
        const val ACTION_SETTINGS = "ca.manix123.directxfer.action.SETTINGS"

        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

        // PWA palette (pwa/app.css dark)
        private val BG = Color.parseColor("#0b1020")
        private val PANEL = Color.parseColor("#151a2e")
        private val PANEL_2 = Color.parseColor("#1b2138")
        private val BORDER = Color.parseColor("#2a3050")
        private val TEXT = Color.parseColor("#e7e9f3")
        private val MUTED = Color.parseColor("#9aa3c7")
        private val FAINT = Color.parseColor("#6b7398")
        private val ACCENT = Color.parseColor("#3b6ef6")
        private val ACCENT_2 = Color.parseColor("#5b8dff")
        private val OK = Color.parseColor("#41d18b")
        private val WARN = Color.parseColor("#ffd166")
        private val DANGER = Color.parseColor("#ff6b81")
    }
}
