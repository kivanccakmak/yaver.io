package io.yaver.feedback

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// ─── The in-app reload control for native Android apps ───────────────────────
//
// Every other Yaver feedback SDK ships a Hot Reload button inside its overlay.
// This SDK deliberately has no overlay — feedback submission is fire-and-forget
// so it can never block the host app's UI — which left native Kotlin as one of
// two stacks where a developer could not reload the app they were looking at
// without leaving it.
//
// So this is the smallest thing that closes that gap honestly:
//
//   • YaverFeedback.reload(mode) { … }  — programmatic, one line, wire it to
//                                          your own debug drawer or gesture.
//   • YaverReloadControl.install(act)    — a floating two-button bar when you
//                                          don't want to build one.
//
// Both refuse to exist in a release build: `isDevBuild` reads the HOST app's
// ApplicationInfo.FLAG_DEBUGGABLE, and ReloadActions.build returns an EMPTY
// list when it is false — there is no code path that renders a reload button
// in a shipped app.

/**
 * Outcome of a reload request.
 *
 * Unlike feedback submission, reload is NOT fire-and-forget: the developer
 * pressed a button and is waiting to see the app reload, so a silent failure
 * here is exactly the defect this SDK exists to avoid.
 */
sealed class ReloadOutcome {
    /** The machine accepted the request. Carries the line to show a human. */
    data class Requested(val message: String) : ReloadOutcome()

    /** It did not happen, and this NAMES why — never "reload failed". */
    data class Failed(val reason: String) : ReloadOutcome()
}

/**
 * Reload entry points, hung off the same object the host already initialised.
 */
object YaverReload {

    private const val TAG = "YaverReload"

    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "yaver-reload").apply { isDaemon = true }
    }

    /**
     * Is the HOST app debuggable?
     *
     * Read from the app's own ApplicationInfo rather than from BuildConfig,
     * because the SDK's BuildConfig describes the SDK's build, not the app's —
     * and it is the app that ships to users.
     */
    @JvmStatic
    fun isDevBuild(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /**
     * Read the dev server's state so a UI can decide WHICH reload actions to
     * offer, and disable the rest with a reason.
     *
     * Hands back null when the machine cannot be reached at all — which the
     * caller must render as "not connected", never as "no dev server". Those
     * are two different problems with two different fixes.
     */
    @JvmStatic
    fun devServerStatus(config: FeedbackConfig, onResult: (DevServerSnapshot?) -> Unit) {
        io.execute {
            var snapshot: DevServerSnapshot? = null
            try {
                val url = URL(config.agentUrl.trimEnd('/') + ReloadActions.STATUS_PATH)
                (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 5_000
                    readTimeout = 8_000
                    setRequestProperty("Authorization", "Bearer ${config.authToken}")
                    if (responseCode in 200..299) {
                        val text = inputStream.bufferedReader().use(BufferedReader::readText)
                        if (text.isNotBlank()) {
                            snapshot = DevServerSnapshot.fromJson(JSONObject(text))
                        }
                    }
                    disconnect()
                }
            } catch (e: Exception) {
                Log.d(TAG, "dev status unreachable: ${e.message}")
            }
            Handler(Looper.getMainLooper()).post { onResult(snapshot) }
        }
    }

    /**
     * Ask the machine's dev server to reload.
     *
     * `FAST` is the framework's cheapest refresh; `FULL` is a framework-level
     * restart (on Flutter the agent maps these to stdin "r" and "R").
     *
     * Auth: the SAME bearer used for the feedback POST. /dev/reload is
     * registered under `authSDKOrGuest` on the agent and is already inside the
     * `guest-reload` SDK-token scope — no new secret, no widened gate.
     */
    @JvmStatic
    @JvmOverloads
    fun reload(
        context: Context,
        config: FeedbackConfig,
        mode: ReloadWireMode = ReloadWireMode.FAST,
        snapshot: DevServerSnapshot? = null,
        onResult: (ReloadOutcome) -> Unit = {},
    ) {
        if (!isDevBuild(context)) {
            // Not an error a user should ever see — a release build has no
            // button to press. Stated anyway so a caller wiring this by hand
            // is told why nothing happened, instead of nothing happening.
            onResult(
                ReloadOutcome.Failed(
                    "Reload is a development-build feature and is disabled in this build."
                )
            )
            return
        }

        io.execute {
            val outcome: ReloadOutcome = try {
                val url = URL(config.agentUrl.trimEnd('/') + ReloadActions.RELOAD_PATH)
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 10_000
                    readTimeout = 30_000
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Authorization", "Bearer ${config.authToken}")
                }
                conn.outputStream.use { it.write("""{"mode":"${mode.wire}"}""".toByteArray()) }
                val code = conn.responseCode
                val result = if (code in 200..299) {
                    ReloadOutcome.Requested(
                        if (mode == ReloadWireMode.FULL) "Full reload requested."
                        else "Hot reload requested."
                    )
                } else {
                    val body = try {
                        conn.errorStream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
                    } catch (e: Exception) {
                        ""
                    }
                    ReloadOutcome.Failed(ReloadActions.describeFailure(code, body, snapshot))
                }
                conn.disconnect()
                result
            } catch (e: Exception) {
                // Status 0 = the request never reached anything. A different
                // problem from a 5xx, so it gets a different sentence.
                ReloadOutcome.Failed(ReloadActions.describeFailure(0, e.message, snapshot))
            }
            Handler(Looper.getMainLooper()).post { onResult(outcome) }
        }
    }
}

/**
 * A floating Hot Reload / Full Reload bar for native Android apps.
 *
 * One call installs it:
 *
 * ```kotlin
 * YaverFeedback.init(this, FeedbackConfig(agentUrl = "…", authToken = "…"))
 * YaverReloadControl.install(activity, config)
 * ```
 *
 * It renders NOTHING in a release build — [install] returns false immediately
 * when the host app is not debuggable, so there is no view, no poll and no
 * network traffic in a shipped app.
 */
object YaverReloadControl {

    private const val POLL_MS = 5_000L

    private var container: LinearLayout? = null
    private var buttonRow: LinearLayout? = null
    private var statusView: TextView? = null
    private var config: FeedbackConfig? = null
    private var snapshot: DevServerSnapshot? = null
    private var inFlight: ReloadActionId? = null
    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, POLL_MS)
        }
    }

    /**
     * Install the floating bar into [activity]. No-op (returns false) in a
     * release build, or if already installed.
     */
    @JvmStatic
    fun install(activity: Activity, config: FeedbackConfig): Boolean {
        if (container != null) return true
        // Same flag ReloadActions.build gates on, so the installer and the
        // renderer can never disagree about whether a shipped app gets a
        // reload button.
        if (!YaverReload.isDevBuild(activity)) return false

        this.config = config

        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 18, 24, 18)
            background = GradientDrawable().apply {
                cornerRadius = 24f
                setColor(Color.argb(200, 0, 0, 0))
            }
        }

        val row = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val status = TextView(activity).apply {
            textSize = 11f
            setTextColor(Color.argb(190, 255, 255, 255))
            text = "Checking the dev server…"
        }

        bar.addView(row)
        bar.addView(status)

        val params = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.END
            bottomMargin = 48
            rightMargin = 48
        }

        // Added to the activity's content root rather than a system overlay
        // window: no SYSTEM_ALERT_WINDOW permission, and the bar disappears
        // with the activity instead of outliving it.
        (activity.window.decorView as? ViewGroup)
            ?.findViewById<ViewGroup>(android.R.id.content)
            ?.addView(bar, params)
            ?: return false

        container = bar
        buttonRow = row
        statusView = status
        render(activity)
        handler.post(poll)
        return true
    }

    /** Remove the bar and stop polling. */
    @JvmStatic
    fun remove() {
        handler.removeCallbacks(poll)
        container?.let { (it.parent as? ViewGroup)?.removeView(it) }
        container = null
        buttonRow = null
        statusView = null
        config = null
        snapshot = null
    }

    private fun refresh() {
        val cfg = config ?: return
        YaverReload.devServerStatus(cfg) { result ->
            snapshot = result
            (buttonRow?.context as? Activity)?.let { render(it) }
        }
    }

    private fun render(activity: Activity) {
        val row = buttonRow ?: return
        val cfg = config ?: return

        val actions = ReloadActions.build(
            snapshot = snapshot,
            isDevBuild = YaverReload.isDevBuild(activity),
            connected = snapshot != null,
            machineLabel = runCatching { URL(cfg.agentUrl).host }.getOrNull(),
        )

        row.removeAllViews()
        for (action in actions) {
            val button = Button(activity).apply {
                text = if (inFlight == action.id) "…" else action.label
                textSize = 12f
                // Greyed but still CLICKABLE when blocked — the click is how
                // we get to say why. A control that silently does nothing is
                // the defect we are fixing.
                setTextColor(
                    if (action.enabled) Color.WHITE else Color.argb(120, 255, 255, 255)
                )
                background = GradientDrawable().apply {
                    cornerRadius = 16f
                    setColor(Color.argb(if (action.enabled) 46 else 18, 255, 255, 255))
                }
                setOnClickListener { run(activity, action) }
            }
            row.addView(button)
        }

        statusView?.text =
            actions.firstOrNull()?.let { if (it.enabled) it.hint else it.disabledReason }
        container?.visibility = if (actions.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun run(activity: Activity, action: ReloadAction) {
        if (!action.enabled) {
            statusView?.text = action.disabledReason
            return
        }
        val cfg = config ?: return
        inFlight = action.id
        statusView?.text = "${action.label}…"
        render(activity)

        YaverReload.reload(activity, cfg, action.mode, snapshot) { outcome ->
            statusView?.text = when (outcome) {
                is ReloadOutcome.Requested -> outcome.message
                // describeFailure already produced a named cause. Show it
                // verbatim rather than replacing it with "Reload failed".
                is ReloadOutcome.Failed -> outcome.reason
            }
            inFlight = null
            render(activity)
            refresh()
        }
    }
}
