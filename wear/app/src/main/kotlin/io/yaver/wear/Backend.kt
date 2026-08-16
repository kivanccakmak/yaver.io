package io.yaver.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Standalone-mode authentication: RFC 8628 OAuth 2.0 Device Authorization Grant
 * against Convex — identical in shape to `mobile/src/lib/tvSignIn.ts` and the
 * tvOS `Backend.swift`. Only needed when the watch runs WITHOUT a paired phone
 * (phone-paired mode holds no token; the phone is the brain-of-record).
 *
 *   POST /auth/device-code                       → { userCode, deviceCode, expiresAt }
 *   GET  /auth/device-code/poll?device_code=...   → { status: "pending"|"authorized"|"expired", token? }
 *
 * Those are the ACTUAL backend field names (camelCase, absolute expiry). This
 * doc used to describe RFC 8628's snake_case names and so did the code, which is
 * why standalone sign-in never once completed. Verified against
 * backend/convex/deviceCode.ts on 2026-07-25.
 *
 * Flow on the watch: show the short [DeviceCode.userCode] + a QR of the
 * verification URI (SignInScreen), poll until approved, persist the returned
 * 1-year session token in the watch's secure store, then use it as the Bearer in
 * [AgentClient]. The watch holds NOTHING until the user explicitly opts into
 * standalone use (design §8 "standalone token custody").
 */
class Backend(
    /** Convex deployment origin, e.g. "https://<deployment>.convex.site". */
    private val convexOrigin: String = DEFAULT_CONVEX_ORIGIN,
) {

    companion object {
        /** Public Convex deployment origin. Mirrors the tvOS / watchOS
         *  `Backend.convexSiteURL` and mobile CONVEX_SITE_URL — NOT a secret
         *  (it's the public backend host). Bump here and in the Swift constants
         *  together if the deployment ever moves. */
        const val DEFAULT_CONVEX_ORIGIN = "https://perceptive-minnow-557.eu-west-1.convex.site"
    }

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    data class DeviceCode(
        val userCode: String,
        val verificationUri: String,
        val deviceCode: String,
        val intervalSeconds: Int,
        val expiresInSeconds: Int,
    )

    sealed class PollResult {
        data class Approved(val sessionToken: String) : PollResult()
        object Pending : PollResult()
        /** The code passed its 15-min TTL — the user needs a fresh one. */
        object Expired : PollResult()
        data class Failed(val reason: String) : PollResult()
    }

    /**
     * Start the device-code flow. Returns the code to display + poll handle.
     *
     * WIRE FORMAT — this was wrong in every detail until 2026-07-25, so match the
     * backend, not RFC 8628's field names:
     *
     *   POST /auth/device-code   JSON {machineName, platform, environment}
     *        -> {"userCode":"ABCD-1234","deviceCode":"<40 hex>","expiresAt":<ms>}
     *
     * The old code sent a FORM body and read `user_code` / `device_code` /
     * `expires_in` / `verification_uri` — none of which the backend sends
     * (backend/convex/deviceCode.ts::createDeviceCode returns camelCase and an
     * ABSOLUTE expiry, and never a verification URI). Every field came back
     * empty, so the watch displayed a blank code and polled a blank handle
     * forever. Cross-checked against the two surfaces that DO work:
     * tvos/YaverTV/Backend.swift and mobile/src/lib/tvSignIn.ts.
     */
    suspend fun requestDeviceCode(): DeviceCode = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("machineName", android.os.Build.MODEL ?: "Wear OS watch")
            .put("platform", "wearos")
            .put("environment", "watch")
            .toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(convexOrigin.trimEnd('/') + "/auth/device-code")
            .post(body)
            .build()
        http.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IllegalStateException("device-code request failed: ${resp.code}")
            }
            val obj = JSONObject(text)
            val userCode = obj.optString("userCode")
            val deviceCode = obj.optString("deviceCode")
            if (userCode.isEmpty() || deviceCode.isEmpty()) {
                // Fail loudly instead of showing a blank code and polling a blank
                // handle until the deadline — that is precisely how this stayed
                // broken without anyone seeing an error.
                throw IllegalStateException("device-code response missing userCode/deviceCode: $text")
            }
            val expiresAtMs = obj.optLong("expiresAt", 0L)
            val remainingSec = if (expiresAtMs > 0) {
                ((expiresAtMs - System.currentTimeMillis()) / 1000L).toInt().coerceAtLeast(1)
            } else {
                900
            }
            DeviceCode(
                userCode = userCode,
                // The backend returns no verification URI; every other surface
                // builds the same one, and the QR below encodes it so the phone's
                // camera lands in the in-app approver.
                verificationUri = "https://yaver.io/auth/device?code=$userCode",
                deviceCode = deviceCode,
                intervalSeconds = obj.optInt("interval", 5),
                expiresInSeconds = remainingSec,
            )
        }
    }

    /** Single poll tick. Caller loops at [DeviceCode.intervalSeconds]. */
    suspend fun pollOnce(deviceCode: String): PollResult = withContext(Dispatchers.IO) {
        try {
            val url = convexOrigin.trimEnd('/') +
                "/auth/device-code/poll?device_code=" + deviceCode
            val request = Request.Builder().url(url).get().build()
            http.newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) return@use PollResult.Failed("poll http ${resp.code}")
                val obj = JSONObject(text)
                // The backend says "authorized" and "token"
                // (backend/convex/deviceCode.ts::pollDeviceCode). This used to
                // look for "approved"/"session_token", so an APPROVED code fell
                // into the `else` branch and was reported as still pending — the
                // watch could never finish signing in, no matter how many times
                // the user approved on their phone. "approved" is still accepted
                // in case an older/self-hosted deployment answers that way.
                when (obj.optString("status")) {
                    "authorized", "approved" -> {
                        val token = obj.optString("token").ifEmpty { obj.optString("session_token") }
                        if (token.isNotEmpty()) PollResult.Approved(token)
                        else PollResult.Failed("authorized without a token")
                    }
                    "pending" -> PollResult.Pending
                    "expired" -> PollResult.Expired
                    // An unknown status is NOT pending. Reporting "pending" for a
                    // state we don't understand is how the mismatch above stayed
                    // invisible for so long; name it instead.
                    else -> PollResult.Failed("unexpected poll status ${obj.optString("status")}")
                }
            }
        } catch (e: Throwable) {
            PollResult.Failed(e.message ?: "poll error")
        }
    }

    /**
     * Convenience: poll until approved/expired. Returns the session token on
     * success, or null on timeout/failure. SignInScreen can call this directly
     * and react to the result.
     */
    suspend fun pollUntilApproved(code: DeviceCode): String? {
        val deadline = System.currentTimeMillis() + code.expiresInSeconds * 1000L
        while (System.currentTimeMillis() < deadline) {
            when (val r = pollOnce(code.deviceCode)) {
                is PollResult.Approved -> return r.sessionToken
                PollResult.Expired -> return null
                // A transient poll failure is NOT the end of the flow. This used
                // to `return null` on the first one, so a single Wi-Fi blip on a
                // wrist — the most likely thing to happen during a 15-minute
                // wait — aborted a sign-in the user was in the middle of
                // approving, with no message. Keep polling until the code really
                // expires; the deadline is the bound.
                is PollResult.Failed -> delay(code.intervalSeconds * 1000L)
                PollResult.Pending -> delay(code.intervalSeconds * 1000L)
            }
        }
        return null
    }

    /**
     * Extend the standalone 1-year session on launch so an opted-in watch NEVER
     * re-prompts for OAuth — the Netflix contract. Only relevant in standalone
     * mode (phone-paired mode holds no token). Device-code mints a 1-year token
     * but nothing extends it; without this it silently hard-expires and forces a
     * fresh sign-in.
     *
     * Extend-only, NO rotation (no X-Yaver-Rotate-Token): a wrist on flaky Wi-Fi
     * routinely loses the response, and rotating would strand it on a dead token
     * → a false logout of a live session. Mirrors mobile's deliberate no-rotate
     * decision (mobile/src/lib/auth.ts, root-caused 2026-07-15) and the tvOS /
     * watchOS Backend.refreshSession. Security: no wider blast radius — the token
     * already lives a year in the watch's own store; we only reset the clock.
     *
     * Returns the rotated token IF the server ever returns one (it won't without
     * opt-in), else null. Any failure is a silent no-op — the existing token
     * stays valid.
     */
    suspend fun refreshSession(token: String): String? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(convexOrigin.trimEnd('/') + "/auth/refresh")
                .header("Authorization", "Bearer $token")
                .header("X-Yaver-Surface", "watch")
                .post(FormBody.Builder().build())
                .build()
            http.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val text = resp.body?.string().orEmpty()
                val rotated = JSONObject(text).optString("token")
                if (rotated.isNotEmpty()) rotated else null
            }
        } catch (e: Throwable) {
            null
        }
    }
}
