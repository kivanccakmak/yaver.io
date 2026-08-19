package io.yaver.tv.ui

import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import io.yaver.tv.Backend
import io.yaver.tv.DevicePollResult
import io.yaver.tv.LanApprovalBeacon
import io.yaver.tv.TvStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.text.input.KeyboardType

/**
 * SignInScreen — the full device-code sign-in: QR + short code + match code,
 * event-first wait with a 5s poll fallback, LAN approval Allow/Deny window
 * (UDP beacon on 19837), elapsed/expiry clock, "Can't reach Yaver — retrying"
 * narration, and email/password as the secondary path. Mirrors
 * tvos/YaverTV/Views/SignInView.swift.
 */
@Composable
fun SignInScreen(store: TvStore, nav: NavHostController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var start by remember { mutableStateOf<io.yaver.tv.DeviceCodeStart?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var unreachable by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf("pending") } // pending | authorized | expired
    var lanPending by remember { mutableStateOf<io.yaver.tv.LanPendingInfo?>(null) }
    var showEmail by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var claimed by remember { mutableStateOf(false) }

    val beacon = remember { LanApprovalBeacon(context) }

    val machineName = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifEmpty { "Android TV" }

    fun begin() {
        error = null
        status = "pending"
        claimed = false
        scope.launch {
            try {
                val s = Backend.startDeviceCode(context, machineName, "androidtv", "tv")
                start = s
                unreachable = null
                if (s.approveNonce != null && s.matchCode != null) {
                    beacon.start(machineName, s.approveNonce, s.matchCode, s.expiresAt)
                }
            } catch (e: Throwable) {
                error = e.message ?: "Couldn't start sign-in. Check your connection."
            }
        }
    }

    fun finishIfAuthorized(r: DevicePollResult, deviceCode: String) {
        if (claimed) return
        if (r.status == "authorized") {
            claimed = true
            status = "authorized"
            val sessionToken = r.token
            scope.launch {
                val token = if (sessionToken.isNullOrEmpty()) {
                    val claimedResult = Backend.claimDeviceCode(deviceCode, r.claimHandle)
                    if (claimedResult.status == "authorized") claimedResult.token else null
                } else sessionToken
                if (token != null) {
                    store.signIn(token)
                    beacon.stop()
                } else {
                    claimed = false
                    unreachable = "Approved, but this TV could not pick up the session yet. Retrying..."
                }
            }
        } else if (r.status == "expired") {
            status = "expired"
            begin()
        }
    }

    // Kick off a code on mount.
    LaunchedEffect(Unit) { begin() }

    // Clock for elapsed/expiry narration.
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }

    // Event-first wait + 5s poll fallback (two concurrent channels, mirroring
    // SignInView.startPolling).
    LaunchedEffect(start?.deviceCode) {
        val deviceCode = start?.deviceCode ?: return@LaunchedEffect
        while (!claimed) {
            val r = Backend.waitDeviceCodeEvent(deviceCode)
            if (r.status == "authorized" || r.status == "expired") {
                finishIfAuthorized(r, deviceCode)
                break
            }
            r.lanPending?.let { lp -> if (status == "pending") lanPending = lp }
            unreachable = r.unreachableReason
            delay(2000)
        }
    }

    LaunchedEffect(start?.deviceCode) {
        val deviceCode = start?.deviceCode ?: return@LaunchedEffect
        while (!claimed) {
            delay(5000)
            val r = Backend.pollDeviceCode(deviceCode)
            if (r.status == "authorized" || r.status == "expired") {
                finishIfAuthorized(r, deviceCode)
                break
            }
            r.lanPending?.let { lp -> if (status == "pending") lanPending = lp }
            unreachable = r.unreachableReason
        }
    }

    // LAN Allow/Deny window: the user presses Allow/Deny → lan-confirm.
    fun lanDecision(allow: Boolean) {
        val deviceCode = start?.deviceCode ?: return
        scope.launch {
            val r = Backend.lanConfirm(deviceCode, allow)
            lanPending = null
            if (r.ok && r.claimHandle != null && !allow) {
                // Denied — the pending window clears; the code stays for QR.
            }
        }
    }

    Row(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).padding(48.dp),
        horizontalArrangement = Arrangement.spacedBy(56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text("Yaver", color = TvColors.TextPrimary, fontSize = 48.sp, fontWeight = FontWeight.Black)
            Text("Sign in to Yaver", color = TvColors.TextPrimary, fontSize = 34.sp, fontWeight = FontWeight.Bold)
            Text("1. Open the Yaver app on your phone", color = TvColors.TextSecondary, fontSize = 20.sp)
            Text("2. Scan this code (or visit yaver.io/auth/device)", color = TvColors.TextSecondary, fontSize = 20.sp)
            Text("3. Tap Approve — this TV signs in instantly", color = TvColors.TextSecondary, fontSize = 20.sp)

            start?.let { s ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("OR ENTER THIS CODE", color = TvColors.TextMuted, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                    Text(
                        s.userCode,
                        color = TvColors.Accent,
                        fontSize = 40.sp,
                        fontWeight = FontWeight.Black,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 4.sp,
                    )
                }
            }

            lanPending?.let { lp ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Approve sign-in from ${lp.approverEmail ?: "your phone"}?", color = TvColors.TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text("Match code: ${lp.matchCode ?: "—"}", color = TvColors.Accent, fontSize = 24.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                    }
                    TvTextButton(label = "Allow", onClick = { lanDecision(true) })
                    TvTextButton(label = "Deny", onClick = { lanDecision(false) })
                }
            }

            error?.let { Text(it, color = TvColors.Red, fontSize = 16.sp) }
            start?.let { s ->
                val elapsed = ((now - (s.expiresAt - 15 * 60 * 1000)) / 1000).toInt().coerceAtLeast(0)
                val remaining = ((s.expiresAt - now) / 1000).toInt().coerceAtLeast(0)
                val hintColor = if (unreachable != null) TvColors.Orange else TvColors.TextMuted
                Text(
                    unreachable ?: "Waiting for approval · ${clock(elapsed)} elapsed · code expires in ${clock(remaining)}",
                    color = hintColor,
                    fontSize = 15.sp,
                )
            }
            if (status == "expired") {
                Text("Code expired — generating a new one…", color = TvColors.TextMuted, fontSize = 15.sp)
            }

            TvTextButton(label = if (showEmail) "Back to QR sign-in" else "Use email + password", onClick = { showEmail = !showEmail })

            if (showEmail) {
                EmailSignInForm(
                    onSuccess = { token ->
                        scope.launch {
                            store.signIn(token)
                            beacon.stop()
                        }
                    },
                )
            }
        }

        // Right column: QR pane.
        Box(
            modifier = Modifier.size(width = 300.dp, height = 300.dp)
                .background(Color.White, RoundedCornerShape(20.dp))
                .padding(20.dp),
            contentAlignment = Alignment.Center,
        ) {
            start?.let { Image(bitmap = renderQr(it.verifyUrl, 260), contentDescription = "Sign-in QR code", modifier = Modifier.size(260.dp)) }
        }
    }
}

@Composable
private fun EmailSignInForm(onSuccess: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = TvColors.TextPrimary,
                unfocusedTextColor = TvColors.TextPrimary,
                focusedBorderColor = TvColors.Accent,
                unfocusedBorderColor = TvColors.Border,
            ),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = TvColors.TextPrimary,
                unfocusedTextColor = TvColors.TextPrimary,
                focusedBorderColor = TvColors.Accent,
                unfocusedBorderColor = TvColors.Border,
            ),
        )
        err?.let { Text(it, color = TvColors.Red, fontSize = 15.sp) }
        TvTextButton(
            label = if (busy) "Signing in…" else "Sign in",
            onClick = {
                if (busy) return@TvTextButton
                busy = true
                err = null
                scope.launch {
                    try {
                        onSuccess(Backend.emailSignIn(email, password))
                    } catch (e: io.yaver.tv.EmailAuthError) {
                        err = when (e) {
                            is io.yaver.tv.EmailAuthError.InvalidCredentials -> "Invalid email or password."
                            is io.yaver.tv.EmailAuthError.LockedOut -> "Too many failed attempts. Wait a bit, then try again."
                            is io.yaver.tv.EmailAuthError.RequiresTwoFactor -> "Two-factor authentication is on. Approve with the QR code above from your phone, or in a browser."
                            is io.yaver.tv.EmailAuthError.Server -> e.message
                        }
                    } catch (e: Throwable) {
                        err = e.message ?: "Email sign-in failed."
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }
}

private fun clock(seconds: Int): String {
    val total = seconds.coerceAtLeast(0)
    val m = total / 60
    val s = total % 60
    return "%d:%02d".format(m, s)
}
