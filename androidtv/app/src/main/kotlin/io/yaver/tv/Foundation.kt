package io.yaver.tv

import org.json.JSONObject
import java.net.URI

/**
 * The named agent error carried across every client in this app.
 *
 * Mirrors tvOS `AgentError` (AgentClient.swift) and the mobile/web twins: a
 * failure must carry a stable code + the agent's own sentence, so a surface
 * can classify it (FailureSignals) instead of inventing a message.
 */
class AgentError(
    override val message: String,
    /** Stable wire code, when the agent supplied one (e.g. reason_codes.go). */
    val code: String? = null,
    /** True when the relay leg refused this account's credential. */
    val relayDeny: Boolean = false,
) : Exception(message)

/** A structured capability gap the agent sent (capability_gap.go) — same shape
 *  as tvOS `CapabilityGap` / `GapFix`. */
data class GapFix(
    val label: String,
    val method: String,
    val path: String,
    val stream: String,
    val est: String?,
    val retry: Boolean,
    val body: Map<String, String> = emptyMap(),
    val instant: Boolean = false,
)

data class CapabilityGap(
    val code: String,
    val capability: String,
    val summary: String,
    val detail: String?,
    val fix: GapFix?,
    val constraint: String?,
    val aiFix: GapFix? = null,
)

data class RelayLimitCard(
    val kind: String,
    val title: String,
    val detail: String,
)

/** Strip absolute home paths (/Users/<name>, /home/<name> → ~) from any string
 *  shown on a television or spoken aloud. Shared by the session pane and the
 *  task list; the path carries the user's login name and filesystem layout, and
 *  these screens get filmed and screen-shared. Mirrors the Convex privacy rule
 *  that keeps absolute paths off the wire. */
fun redactHomePaths(text: String): String {
    var out = text
    for (root in listOf("/Users/", "/home/")) {
        while (true) {
            val idx = out.indexOf(root)
            if (idx < 0) break
            var end = idx + root.length
            while (end < out.length && !out[end].isWhitespace() && out[end] != '/') end++
            if (end == idx + root.length) break
            out = out.substring(0, idx) + "~" + out.substring(end)
        }
    }
    return out
}

/** Parse a JSON object response body; throws AgentError on {ok:false,error}. */
fun JSONObject.parseError(): String? {
    if (optBoolean("ok", true)) return null
    return optString("error").ifEmpty { null }
}

/** The surface id sent as X-Yaver-Surface everywhere, mirroring
 *  Backend.surface in tvOS (Info.plist YaverNativeSurface). */
const val TV_SURFACE_ID = "androidtv"
