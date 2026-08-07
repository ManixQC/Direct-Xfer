package ca.manix123.directxfer.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("dx_secure", Context.MODE_PRIVATE)
    private val alias = "direct_xfer_companion_store"

    var serverUrl: String?
        get() = getEncrypted("server")
        set(value) = putEncrypted("server", value)
    var deviceToken: String?
        get() = getEncrypted("token")
        set(value) = putEncrypted("token", value)
    var csrf: String?
        get() = getEncrypted("csrf")
        set(value) = putEncrypted("csrf", value)
    var biometricEnabled: Boolean
        get() = prefs.getBoolean("biometric", false)
        set(value) { prefs.edit().putBoolean("biometric", value).apply() }
    var cleanExif: Boolean
        get() = prefs.getBoolean("clean_exif", true)
        set(value) { prefs.edit().putBoolean("clean_exif", value).apply() }
    var defaultImageLinks: Boolean
        get() = prefs.getBoolean("default_image_links", true)
        set(value) { prefs.edit().putBoolean("default_image_links", value).apply() }
    // Item 8: restrict uploads to unmetered (Wi-Fi) networks.
    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifi_only", false)
        set(value) { prefs.edit().putBoolean("wifi_only", value).apply() }
    // Item 22: global pause flag honoured by the scheduler and the recovery worker.
    var pausedAll: Boolean
        get() = prefs.getBoolean("paused_all", false)
        set(value) { prefs.edit().putBoolean("paused_all", value).apply() }
    // Item 13: configurable image pipeline (max side per variant + JPEG quality).
    var imageFullMax: Int
        get() = prefs.getInt("img_full_max", 4096)
        set(value) { prefs.edit().putInt("img_full_max", value.coerceIn(512, 8192)).apply() }
    var imageThumbMax: Int
        get() = prefs.getInt("img_thumb_max", 1280)
        set(value) { prefs.edit().putInt("img_thumb_max", value.coerceIn(256, 4096)).apply() }
    var imageMicroMax: Int
        get() = prefs.getInt("img_micro_max", 640)
        set(value) { prefs.edit().putInt("img_micro_max", value.coerceIn(96, 2048)).apply() }
    var imageQuality: Int
        get() = prefs.getInt("img_quality", 93)
        set(value) { prefs.edit().putInt("img_quality", value.coerceIn(40, 100)).apply() }
    // Item 16: language override ("fr"/"en"/"es"); null follows the system locale.
    var language: String?
        get() = prefs.getString("language", null)
        set(value) {
            if (value.isNullOrBlank()) prefs.edit().remove("language").apply()
            else prefs.edit().putString("language", value).apply()
        }

    fun isPaired() = !serverUrl.isNullOrBlank() && !deviceToken.isNullOrBlank() && !csrf.isNullOrBlank()

    fun clearCredentials() {
        prefs.edit().remove("server").remove("token").remove("csrf").apply()
    }

    @Synchronized
    private fun putEncrypted(key: String, value: String?) {
        if (value == null) { prefs.edit().remove(key).apply(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        prefs.edit().putString(key, encoded).apply()
    }

    @Synchronized
    private fun getEncrypted(key: String): String? {
        val raw = prefs.getString(key, null) ?: return null
        return try {
            val parts = raw.split(':', limit = 2)
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) { null }
    }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
