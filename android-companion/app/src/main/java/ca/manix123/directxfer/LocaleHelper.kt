package ca.manix123.directxfer

import android.content.Context
import android.content.res.Configuration
import ca.manix123.directxfer.security.SecureStore
import java.util.Locale

/**
 * Item 16: applies the in-app language override (fr/en/es) chosen by the user.
 * When no override is stored the system locale is used. Called from
 * [android.app.Activity.attachBaseContext] so it only reads a plain SharedPreferences
 * value (no Android Keystore access at that early lifecycle point).
 */
object LocaleHelper {
    fun wrap(base: Context): Context {
        val lang = SecureStore(base).language?.takeIf { it.isNotBlank() } ?: return base
        val locale = Locale.forLanguageTag(lang)
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration)
        config.setLocale(locale)
        return base.createConfigurationContext(config)
    }
}
