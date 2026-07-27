package io.yaver.feedback

import org.json.JSONObject

// ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
//
// Kotlin port of sdk/feedback/{web,react-native}/src/reloadActions.ts,
// sdk/feedback/flutter/lib/src/reload_actions.dart,
// sdk/feedback/unity/Runtime/YaverReloadActions.cs and
// sdk/feedback/swift/Sources/YaverFeedback/ReloadActions.swift. Same three
// questions, same answers, same wording — because a bug fixed in one SDK must
// not still be shipping in the other five:
//
//   1. WHICH actions may be shown at all (release build ⇒ none, ever)?
//   2. WHICH request does each action make (path + body)?
//   3. WHEN a reload fails, WHAT do we tell the user?
//
// Deliberately PURE — no HttpURLConnection, no Context, no Android framework
// types. That is what makes it JVM-unit-testable without an emulator, and the
// test is the guard.
//
// ── Wire contract (desktop/agent/devserver_http.go) ──────────────────────────
//
//   POST /dev/reload      {"mode": "fast" | "full"}
//        fast — the dev server's cheapest refresh.
//        full — framework-level restart (Flutter stdin "R").
//        Absent/unknown normalises to "fast" on the agent, so an old client
//        keeps its exact old behaviour.
//
//   POST /dev/reload-app  {"mode": "bundle"}
//        Hermes bytecode rebuild — React Native ONLY. A native Kotlin app can
//        never load one, so this SDK does not offer it. Offering an action
//        that cannot work teaches the user the product lies.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// No new secret. /dev/reload is registered under `authSDKOrGuest` in
// desktop/agent/httpserver.go — the same middleware that already admits the
// bearer this SDK sends with its feedback POST — and the scope-limited
// `guest-reload` SDK token already lists the route.

/** Stable identifier for each action the UI can render. */
enum class ReloadActionId { HOT, FULL }

/** Wire value of the `mode` field on POST /dev/reload. */
enum class ReloadWireMode(val wire: String) {
    FAST("fast"),
    FULL("full"),
}

/** Framework families whose reload vocabulary we borrow. */
enum class ReloadFrameworkFamily { FLUTTER, REACT_NATIVE, WEB, UNKNOWN }

/** The part of `GET /dev/status` this decision depends on. */
data class DevServerSnapshot(
    /** Is a dev server process alive on the machine? */
    val running: Boolean,
    /** Is it still compiling? A reload now would race the build. */
    val building: Boolean = false,
    /** Agent framework name: expo | react-native | flutter | vite | nextjs. */
    val framework: String? = null,
) {
    companion object {
        /**
         * Parse a `/dev/status` body.
         *
         * Anything missing or malformed degrades to "not running" rather than
         * to an optimistic default — claiming a dev server we have not seen is
         * how a button ends up doing nothing in silence.
         */
        @JvmStatic
        fun fromJson(json: JSONObject): DevServerSnapshot = DevServerSnapshot(
            running = json.optBoolean("running", false),
            building = json.optBoolean("building", false),
            framework = json.optString("framework", "").ifBlank { null },
        )
    }
}

/** One button the UI may render. */
data class ReloadAction(
    val id: ReloadActionId,
    /** Button label — stack-idiomatic wording lives here, not at the call site. */
    val label: String,
    /** One line explaining what the action actually does. */
    val hint: String,
    val mode: ReloadWireMode,
    /** Agent path this action POSTs to. */
    val path: String,
    val enabled: Boolean,
    /**
     * Set exactly when [enabled] is false. Names the specific blocker and the
     * fix — never "unavailable".
     */
    val disabledReason: String? = null,
) {
    /** The exact request body this action sends. */
    val bodyJson: String get() = """{"mode":"${mode.wire}"}"""
}

object ReloadActions {

    const val RELOAD_PATH = "/dev/reload"
    const val RELOAD_APP_PATH = "/dev/reload-app"
    const val STATUS_PATH = "/dev/status"

    /**
     * Map the agent's framework name onto a family.
     *
     * An unrecognised framework still gets generic actions: the agent is the
     * authority on what it can do, and refusing to offer a reload because we
     * did not recognise a name would be us inventing a limit the product does
     * not have.
     */
    @JvmStatic
    fun frameworkFamily(framework: String?): ReloadFrameworkFamily {
        val f = (framework ?: "").trim().lowercase()
        if (f.isEmpty()) return ReloadFrameworkFamily.UNKNOWN
        if (f.contains("flutter")) return ReloadFrameworkFamily.FLUTTER
        if (f == "expo" || f.contains("react-native") || f.contains("metro")) {
            return ReloadFrameworkFamily.REACT_NATIVE
        }
        if (f == "vite" || f == "next" || f == "nextjs" || f == "web" || f == "webpack") {
            return ReloadFrameworkFamily.WEB
        }
        return ReloadFrameworkFamily.UNKNOWN
    }

    private fun labels(family: ReloadFrameworkFamily): Pair<Pair<String, String>, Pair<String, String>> =
        when (family) {
            ReloadFrameworkFamily.FLUTTER -> Pair(
                "Hot Reload" to "Flutter hot reload (r) — keeps the current app state.",
                "Hot Restart" to "Flutter hot restart (R) — restarts the app and resets state.",
            )
            ReloadFrameworkFamily.REACT_NATIVE -> Pair(
                "Hot Reload" to "Fast Refresh through Metro — keeps component state.",
                "Full Reload" to "Reloads the whole JS bundle and resets state.",
            )
            ReloadFrameworkFamily.WEB -> Pair(
                "Hot Reload" to "Hot module replacement through the dev server.",
                "Full Reload" to "Re-exports the bundle and reloads the page.",
            )
            ReloadFrameworkFamily.UNKNOWN -> Pair(
                "Hot Reload" to "The dev server's cheapest refresh.",
                "Full Reload" to "Framework-level restart of the running app.",
            )
        }

    /**
     * The whole decision, in one pure function.
     *
     * Returns the ordered list the UI should render. An EMPTY list means
     * "render no reload UI at all" — that is the release-build answer, and it
     * is deliberately indistinguishable from "this SDK has no reload feature",
     * because to a shipped app it doesn't.
     *
     * A NON-empty list may still contain disabled entries: showing a greyed
     * "Hot Reload — no dev server is running on primary" teaches the user what
     * to fix. Hiding it teaches them nothing.
     *
     * @param isDevBuild Android's signal is
     *   `ApplicationInfo.FLAG_DEBUGGABLE` on the host app. There is no default
     *   here on purpose: false means the list is EMPTY, and a shipped app
     *   never gets a reload button.
     */
    @JvmStatic
    @JvmOverloads
    fun build(
        snapshot: DevServerSnapshot?,
        isDevBuild: Boolean,
        connected: Boolean,
        machineLabel: String? = null,
    ): List<ReloadAction> {
        // 1. Release build — never, under any circumstance.
        if (!isDevBuild) return emptyList()

        val snap = snapshot ?: DevServerSnapshot(running = false)
        val (hot, full) = labels(frameworkFamily(snap.framework))
        val machine = (machineLabel ?: "").trim().ifEmpty { "the selected machine" }

        val blocked: String? = when {
            !connected -> "Not connected to a machine yet — pick one first."
            snap.building ->
                "The dev server is still building — reload works once it finishes."
            !snap.running ->
                "No dev server is running on $machine. " +
                    "Start one from the Yaver app, or run `yaver dev start` there."
            else -> null
        }

        return listOf(
            ReloadAction(
                id = ReloadActionId.HOT,
                label = hot.first,
                hint = hot.second,
                mode = ReloadWireMode.FAST,
                path = RELOAD_PATH,
                enabled = blocked == null,
                disabledReason = blocked,
            ),
            ReloadAction(
                id = ReloadActionId.FULL,
                label = full.first,
                hint = full.second,
                mode = ReloadWireMode.FULL,
                path = RELOAD_PATH,
                enabled = blocked == null,
                disabledReason = blocked,
            ),
        )
    }

    /**
     * Turn a failed reload into a sentence that names the cause AND the fix.
     *
     * "Reload failed" is the shape of error this codebase keeps paying whole
     * sessions for. Every branch below exists because the raw text the agent
     * (or Go's net stack) produces is accurate and unreadable.
     *
     * @param status 0 means the request never reached anything — a different
     *   problem from a 5xx, needing a different sentence.
     */
    @JvmStatic
    @JvmOverloads
    fun describeFailure(
        status: Int,
        body: String?,
        snapshot: DevServerSnapshot? = null,
    ): String {
        val lower = (body ?: "").lowercase()
        val framework = (snapshot?.framework ?: "").trim()

        if (lower.contains("does not support hot reload")) {
            val name = framework.ifEmpty { "This dev server" }
            return "$name cannot hot reload. Restart the dev server on the machine."
        }
        if (status == 503 ||
            lower.contains("no dev server") ||
            lower.contains("dev server not available")
        ) {
            return "No dev server is running on the machine. Start one before reloading."
        }
        if ((lower.contains("connection refused") || lower.contains("econnrefused")) &&
            (lower.contains("127.0.0.1") || lower.contains("localhost"))
        ) {
            return "The dev server is not listening on the machine. " +
                "Start it with `yaver dev start`."
        }
        if (status == 401 || status == 403) {
            return "The machine rejected this session — sign in again, or re-pair this device."
        }
        if (status == 404) {
            return "This machine's agent has no /dev/reload route — it is too old. " +
                "Update it with `npm install -g yaver-cli@latest`."
        }
        if (status >= 500) {
            return "The agent hit an internal error while reloading. " +
                "Check `yaver logs` on the machine."
        }
        if (status == 0) {
            return "Could not reach the machine. Check that it is online and " +
                "`yaver serve` is running."
        }
        return "Reload failed (HTTP $status)."
    }
}
