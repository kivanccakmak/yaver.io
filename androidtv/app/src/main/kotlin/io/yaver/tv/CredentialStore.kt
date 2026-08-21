package io.yaver.tv

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** App-private credential vault. Values are AES-GCM encrypted with a
 * non-exportable Android Keystore key and are never returned by inventory APIs. */
object CredentialStore {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "io.yaver.tv.credentials.v1"
    private const val PREFS = "io.yaver.tv.credentials.v1"
    val allowedKinds = setOf("deepseek-api-key", "openai-api-key", "anthropic-api-key", "glm-api-key", "github-token", "gitlab-token", "bitbucket-token")

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }

    fun save(context: Context, kind: String, value: CharArray) {
        require(kind in allowedKinds && value.isNotEmpty()) { "Unsupported or empty credential" }
        val bytes = String(value).toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(kind.toByteArray(Charsets.UTF_8))
            val blob = cipher.iv + cipher.doFinal(bytes)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(kind, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()
        } finally {
            bytes.fill(0)
            value.fill('\u0000')
        }
    }

    /** Use the value in a bounded callback so callers cannot accidentally put
     * it in Compose state, logs, telemetry or a long-lived model. */
    fun <T> use(context: Context, kind: String, block: (CharArray) -> T): T? {
        require(kind in allowedKinds)
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(kind, null) ?: return null
        val blob = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob.copyOfRange(0, 12)))
        cipher.updateAAD(kind.toByteArray(Charsets.UTF_8))
        val plain = cipher.doFinal(blob.copyOfRange(12, blob.size))
        val chars = String(plain, Charsets.UTF_8).toCharArray()
        return try { block(chars) } finally { plain.fill(0); chars.fill('\u0000') }
    }

    fun availableKinds(context: Context): Set<String> = allowedKinds.filterTo(mutableSetOf()) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(it)
    }
}
