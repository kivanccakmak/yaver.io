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

/**
 * TokenStore — Keystore-backed storage for the TV's Yaver bearer token.
 *
 * The token is a one-year Yaver session. SharedPreferences is acceptable for
 * the selected box and UI preferences, but not for a bearer credential, so the
 * token is AES-GCM encrypted with a key that lives in the Android Keystore
 * (hardware-backed where available) and never leaves the device. Mirror of
 * tvOS TokenStore.swift (Keychain, kSecAttrAccessibleAfterFirstUnlock).
 */
object TokenStore {

    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "io.yaver.tv.session"
    private const val PREFS = "io.yaver.tv.secure"
    private const val CIPHER_TEXT = "session_token"

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun getOrCreateKey(): SecretKey {
        val ks = keyStore()
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun load(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val stored = prefs.getString(CIPHER_TEXT, null) ?: return ""
        return try {
            val key = getOrCreateKey()
            val blob = Base64.decode(stored, Base64.NO_WRAP)
            val iv = blob.copyOfRange(0, 12)
            val ciphertext = blob.copyOfRange(12, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: Throwable) {
            // Key rotation / restore edge: drop the unreadable blob so the
            // user gets a clean sign-in instead of an unbreakable loop.
            clear(context)
            ""
        }
    }

    fun save(context: Context, token: String) {
        try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            val blob = cipher.iv + ciphertext
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(CIPHER_TEXT, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
        } catch (e: Throwable) {
            // Never crash the sign-in path over storage; the caller can still
            // hold the token in memory for the session.
        }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(CIPHER_TEXT).apply()
    }
}
