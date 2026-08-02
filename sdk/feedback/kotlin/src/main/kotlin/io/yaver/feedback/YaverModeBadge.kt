package io.yaver.feedback

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView

/**
 * The polite "you're running inside Yaver" mark for native Android apps.
 *
 * ─── Why detection here is NOT the same problem as on RN/web ────────────────
 *
 * A native Android app is never a Hermes guest — the container loads React
 * Native bytecode, and there is no mechanism by which a Kotlin app runs inside
 * it (see the note at the top of YaverFeedback.kt). So `NativeModules.YaverInfo`
 * has no counterpart here and the RN detection does not port.
 *
 * What DOES happen is streaming: the app runs on a Cloud Workspace box, in
 * Redroid or an emulator, and the pixels arrive on someone's phone. That is
 * genuinely a "you are not looking at the installed app" situation and is worth
 * a mark.
 *
 * ─── Why we do not sniff the emulator ───────────────────────────────────────
 *
 * The tempting probe is `Build.FINGERPRINT.contains("generic")` or
 * `ro.kernel.qemu`. It is WRONG, and wrong in the expensive direction: a
 * developer running their own emulator would be told "you are inside Yaver"
 * when they are not. A false claim about which build you are looking at is
 * worse than no claim — it is the same class of defect as an inventory that
 * says yes while the operation says no, and it would teach people to ignore
 * the mark.
 *
 * So detection is EXPLICIT and fails closed:
 *
 *   1. the launching side sets `yaver.streamed` (a system property the agent
 *      can set when it starts the app in a remote runtime), or
 *   2. the host app calls [setStreamed] because it knows, or
 *   3. no mark is shown.
 *
 * Absent evidence, we say nothing. That is the honest default.
 */
object YaverModeBadge {

    private const val TAG_VIEW = "yaver_mode_badge"
    private const val ACCENT = 0xFF7C5CFF.toInt()

    /**
     * Per-RUN dismissal. In memory on purpose: a permanently hidden mark
     * recreates the problem it exists to prevent — a tester who cannot tell a
     * streamed dev build from the installed app. Polite means not nagging
     * within a session, not permanent amnesia. An app that wants it gone for
     * good simply never calls [attach].
     */
    @Volatile
    private var hiddenThisRun = false

    @Volatile
    private var streamedOverride: Boolean? = null

    /** Tell the SDK this process is being streamed by Yaver. */
    @JvmStatic
    fun setStreamed(streamed: Boolean) {
        streamedOverride = streamed
    }

    /** Hide the mark for the rest of this run. Returns on next launch. */
    @JvmStatic
    fun hide(activity: Activity?) {
        hiddenThisRun = true
        activity ?: return
        val root = activity.window?.decorView as? ViewGroup ?: return
        root.findViewWithTag<View>(TAG_VIEW)?.let { root.removeView(it) }
    }

    /** Bring it back — e.g. when the app enters a new streamed context. */
    @JvmStatic
    fun show(activity: Activity?) {
        hiddenThisRun = false
        attach(activity)
    }

    @JvmStatic
    fun isHidden(): Boolean = hiddenThisRun

    /**
     * Whether this process is running inside Yaver, as far as we can honestly
     * tell. Explicit signals only — see the class docs for why sniffing the
     * emulator is refused.
     */
    @JvmStatic
    fun isInsideYaver(): Boolean {
        streamedOverride?.let { return it }
        return readSystemProperty("yaver.streamed").equals("1", ignoreCase = true) ||
            readSystemProperty("yaver.streamed").equals("true", ignoreCase = true)
    }

    /**
     * Add the mark to [activity]'s decor view. No-op when we cannot honestly
     * claim the app is inside Yaver, when the user hid it, or when it is
     * already attached.
     *
     * Call it from `onResume`. Safe to call repeatedly.
     */
    @JvmStatic
    fun attach(activity: Activity?) {
        activity ?: return
        if (hiddenThisRun || !isInsideYaver()) return
        val root = activity.window?.decorView as? ViewGroup ?: return
        if (root.findViewWithTag<View>(TAG_VIEW) != null) return

        val size = dp(activity, 22f)
        val mark = TextView(activity).apply {
            tag = TAG_VIEW
            text = "Y"
            setTextColor(ACCENT)
            textSize = 12f
            gravity = Gravity.CENTER
            contentDescription = "Running inside Yaver"
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(36, 124, 92, 255))
                setStroke(dp(activity, 1f), Color.argb(115, 124, 92, 255))
            }
            alpha = 0.9f
            setOnClickListener { explain(activity) }
        }

        // Bottom-LEFT: bottom-right is where most apps put a FAB, and the mark
        // must never compete with the app's own primary action.
        val lp = FrameLayout.LayoutParams(size, size).apply {
            gravity = Gravity.BOTTOM or Gravity.START
            leftMargin = dp(activity, 12f)
            bottomMargin = dp(activity, 28f)
        }
        root.addView(mark, lp)
    }

    private fun explain(activity: Activity) {
        AlertDialog.Builder(activity)
            .setTitle("Running inside Yaver")
            .setMessage(
                "This app is being streamed from a Yaver box — it is a development build, not " +
                    "the version installed on a device. Anything unfinished here is work in " +
                    "progress, not a released bug.\n\n" +
                    "The way back lives in the Yaver viewer's own chrome, outside the video, " +
                    "which is what makes it impossible to lose.\n\n" +
                    "Hiding this mark lasts until the next launch, so nobody forgets which " +
                    "build they are testing."
            )
            // Polite means closeable. "for now", never "don't show again".
            .setNegativeButton("Hide for now") { d, _ ->
                hide(activity)
                d.dismiss()
            }
            .setPositiveButton("Close") { d, _ -> d.dismiss() }
            .show()
    }

    private fun dp(activity: Activity, value: Float): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, activity.resources.displayMetrics
        ).toInt()

    private fun readSystemProperty(key: String): String {
        return try {
            @Suppress("PrivateApi")
            val clazz = Class.forName("android.os.SystemProperties")
            val get = clazz.getMethod("get", String::class.java)
            (get.invoke(null, key) as? String).orEmpty()
        } catch (_: Throwable) {
            // Not reachable on every OEM image. Absent evidence ⇒ say nothing.
            ""
        }
    }

    /** Kept so a caller can log what the mark decided without re-deriving it. */
    @JvmStatic
    fun describeDetection(): String = when {
        streamedOverride == true -> "explicit: setStreamed(true)"
        streamedOverride == false -> "explicit: setStreamed(false)"
        isInsideYaver() -> "system property yaver.streamed"
        else -> "no Yaver signal (Build=${Build.FINGERPRINT.take(24)}…) — no mark shown"
    }
}
