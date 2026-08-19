package io.yaver.tv

import java.util.regex.Pattern

/**
 * FailureSignals — the Android TV port of the four named-failure seams that
 * reached the native tvOS app (tvos/YaverTV/FailureSignals.swift).
 *
 * WHY THIS FILE EXISTS. Cross-surface parity (CLAUDE.md): "a fix is not done
 * until it exists on all surfaces", and native surfaces do NOT inherit the RN
 * fix — they have their own code and must be ported explicitly. The signals
 * live as TypeScript twins (mobile/src/lib + web/lib), a Swift twin (tvOS), and
 * now this Kotlin twin:
 *
 *   1. capabilityGap        — a missing toolchain, NAMED, with a tappable
 *                              install route and a stream to watch it run.
 *   2. taskStreamRecovery   — a stream that ended without a `done` frame is an
 *                              INTERRUPTION, not a finish; reattach and say so.
 *   3. relayDeny            — the relay's verdicts (device_mismatch, free tier,
 *                              bandwidth cap) rendered as themselves instead of
 *                              generic unreachability.
 *   4. runnerAuthFlow       — `account_not_eligible` is TERMINAL, and a pending
 *                              auth session must narrate its wait.
 *
 * Every sentence below is copied from its Swift/TypeScript twin on purpose. A
 * user who reads one wording on their phone and a different wording on the TV
 * learns that Yaver's diagnosis depends on which screen they picked up. When
 * you change a sentence in tvos/YaverTV/FailureSignals.swift or the TS twins,
 * change it here.
 *
 * PURE: no Android imports (only java.util), so a plain JUnit test can prove it
 * without an emulator. See androidtv/README.md "Verifying FailureSignals".
 */
object FailureSignals {

    // ── 0. Session scope denial ───────────────────────────────────────────

    /** Wire code for "this session token's companion scope forbids this
     *  endpoint" — reason_codes.go ReasonAuthSessionScopeDenied. A scope 403
     *  is NEVER retryable from the TV: the allowlist lives in the agent, so
     *  hitting one means the box runs an agent older than this app. The route
     *  is an agent update, not a Try again. */
    const val SESSION_SCOPE_DENIED = "auth.session.scope_denied"

    /** Code-first, with ONE prose shim for agents that predate the code. */
    fun isSessionScopeDenied(code: String?, message: String?): Boolean {
        if (code == SESSION_SCOPE_DENIED) return true
        return message?.contains("scoped token cannot access this endpoint") == true
    }

    /** The sentence + route for a scope denial, in TV words. */
    fun explainSessionScopeDenied(): String =
        "The agent on this box is older than this TV app, so it refuses the preview endpoints. Update the agent and this screen will work."

    // ── 0b. Runner/render target probe failures ───────────────────────────

    /** Mirror of web/lib/runtimeTargetProbeFailure.ts — raw values are the
     *  CROSS-SURFACE names and must match it exactly. */
    enum class TargetProbeKind(val wire: String) {
        RelayAuth("auth"),
        RelayPresence("relay-presence"),
        RelayRoute("relay-route"),
        AgentVerbSkew("agent-verb-skew"),
        ProjectMissing("project-missing"),
        Other("other"),
    }

    data class TargetProbePlan(
        val kind: TargetProbeKind,
        val retry: Boolean,
        val useRunnerFallback: Boolean,
        val showFixWithRunner: Boolean,
    )

    const val RELAY_DEVICE_NOT_CONNECTED_CODE = "relay.device_not_connected"
    const val RELAY_DEVICE_NOT_CONNECTED_REASON = "connectivity.relay.device_not_connected"
    const val PROJECT_NOT_ON_THIS_MACHINE_CODE = "project_not_on_this_machine"

    /** A relay CREDENTIAL refusal — the account's relay password is missing or
     *  stale. Self-healable and emphatically not the agent's fault, so it must
     *  never reach a coding runner. OpsClient/SessionClient use it to decide
     *  when to run the /settings/repair-relay self-heal. */
    fun isRelayCredentialFailure(lower: String): Boolean =
        lower.contains("relay_password_missing") ||
            lower.contains("relay_password_invalid") ||
            lower.contains("relay_password_rate_limited") ||
            lower.contains("relay password missing") ||
            lower.contains("invalid relay password") ||
            lower.contains("relay password mismatch") ||
            lower.contains("too many invalid relay password attempts") ||
            lower.contains("reason=bad_password") ||
            lower.contains("relay authentication failed")

    fun isRelayCredentialDeny(message: String?): Boolean =
        isRelayCredentialFailure((message ?: "").lowercase())

    fun classifyTargetProbeFailure(error: String?): TargetProbePlan {
        val lower = (error ?: "").lowercase()
        if (isRelayCredentialFailure(lower)) {
            return TargetProbePlan(TargetProbeKind.RelayAuth, true, false, false)
        }
        if (lower.contains("unknown_verb") || lower.contains("unknown verb")) {
            return TargetProbePlan(TargetProbeKind.AgentVerbSkew, true, false, false)
        }
        if (lower.contains(RELAY_DEVICE_NOT_CONNECTED_CODE) ||
            lower.contains(RELAY_DEVICE_NOT_CONNECTED_REASON) ||
            lower.contains("device not connected to relay")
        ) {
            return TargetProbePlan(TargetProbeKind.RelayPresence, true, true, false)
        }
        if (lower.contains("only reachable over a relay")) {
            return TargetProbePlan(TargetProbeKind.RelayRoute, true, true, false)
        }
        if (lower.contains("render_unreachable") ||
            (lower.contains("render machine") && lower.contains("not reachable")) ||
            (lower.contains("runner/render split") && lower.contains("not reachable"))
        ) {
            return TargetProbePlan(TargetProbeKind.RelayPresence, true, true, false)
        }
        if (lower.contains(PROJECT_NOT_ON_THIS_MACHINE_CODE) ||
            lower.contains("on this machine — check") ||
            lower.contains("on this machine - check") ||
            (lower.contains("no mobile project named") && lower.contains("on this machine"))
        ) {
            return TargetProbePlan(TargetProbeKind.ProjectMissing, false, true, false)
        }
        return TargetProbePlan(TargetProbeKind.Other, false, false, true)
    }

    /** Copied verbatim from web/lib/relayAuth.ts::RELAY_TUNNEL_DOWN_REMEDY. */
    const val RELAY_TUNNEL_DOWN_REMEDY: String =
        "The relay is up but has no tunnel to this machine, so nothing reached the agent. " +
            "That is what a box with an expired session looks like from here — it cannot register with the relay. " +
            "Run `yaver auth` on the machine itself; re-auth from the web rides the tunnel that is missing."

    /** The TV sentence for a target-probe verdict, or null when there is
     *  nothing worth saying. */
    fun explainTargetProbe(plan: TargetProbePlan, renderBox: String?, runnerBox: String?): String? {
        val render = if (!renderBox.isNullOrEmpty()) renderBox else "the render machine"
        return when (plan.kind) {
            TargetProbeKind.RelayAuth ->
                "The relay refused this account's credentials, so the probe never reached $render. Sign in again and retry — the box itself is fine."
            TargetProbeKind.RelayPresence ->
                "$render has no live relay connection, so the target probe never reached it. Bring that box online, or pick a different render machine."
            TargetProbeKind.RelayRoute ->
                "$render is only reachable over a relay from here, and that route is not available right now."
            TargetProbeKind.AgentVerbSkew ->
                "The agent on $render is older than this TV app and does not know the call it just received. Update it with `npm install -g yaver-cli@latest`, then retry."
            TargetProbeKind.ProjectMissing ->
                if (!runnerBox.isNullOrEmpty()) {
                    "$render has no project by that name. The project list came from $runnerBox — render there, or pick a project $render itself reports."
                } else {
                    "$render has no project by that name, so there is nothing there to render — the box itself is fine."
                }
            TargetProbeKind.Other -> null
        }
    }

    // ── 0c. Runner failure kinds ──────────────────────────────────────────

    /** THE LAW: a failure that is not about the credential must never route the
     *  user into a sign-in flow. Billing, throttling, model entitlement and a
     *  missing provider key are all VALID credentials failing for other reasons. */
    enum class RunnerFailureKind(val wire: String) {
        Auth("auth"),
        AuthRevoked("auth-revoked"),
        Billing("billing"),
        RateLimit("rate-limit"),
        ModelNotSupported("model-not-supported"),
        ModelNotFound("model-not-found"),
        ProviderKey("provider-key"),
        Unknown("unknown"),
    }

    /** Ordered most-specific first: the generic auth matcher would otherwise
     *  swallow billing and throttling. */
    fun classifyRunnerFailure(output: String?): RunnerFailureKind {
        val m = (output ?: "").lowercase()
        if (m.isEmpty()) return RunnerFailureKind.Unknown

        if (m.contains("credit balance is too low") || m.contains("credit_balance_too_low") ||
            m.contains("plans & billing")
        ) return RunnerFailureKind.Billing
        if (m.contains("rate_limit_error") || m.contains("rate limit reached") ||
            m.contains("rate limit exceeded") || m.contains("too many requests")
        ) return RunnerFailureKind.RateLimit
        if (m.contains("ai_loadapikeyerror") || m.contains("api key is missing") ||
            m.contains("load api key")
        ) return RunnerFailureKind.ProviderKey
        if (m.contains("model is not supported") || m.contains("does not have access to model") ||
            m.contains("unsupported model")
        ) return RunnerFailureKind.ModelNotSupported
        if (m.contains("providermodelnotfounderror") || m.contains("provider model not found") ||
            m.contains("invalid model")
        ) return RunnerFailureKind.ModelNotFound
        if (m.contains("oauth access token has been revoked") || m.contains("token has been revoked")) {
            return RunnerFailureKind.AuthRevoked
        }
        if (m.contains("oauth token has expired") || m.contains("oauth session expired") ||
            m.contains("authentication_error") || m.contains("authentication_failed") ||
            m.contains("not authenticated") || m.contains("not logged in") ||
            m.contains("please sign in") || m.contains("invalid bearer token") ||
            m.contains("unauthorized") || m.contains("expired token") ||
            m.contains("token_expired") || m.contains("please run /login") ||
            m.contains("run codex login") || m.contains("codex login --device-auth") ||
            m.contains("refresh_token_reused")
        ) return RunnerFailureKind.Auth
        return RunnerFailureKind.Unknown
    }

    /** True only when signing the runner in again can actually fix it. */
    fun runnerFailureRoutesToSignIn(kind: RunnerFailureKind): Boolean =
        kind == RunnerFailureKind.Auth || kind == RunnerFailureKind.AuthRevoked

    /** The sentence + action in TV words, or null when there is nothing to say. */
    fun explainRunnerFailure(kind: RunnerFailureKind): Pair<String, String>? = when (kind) {
        RunnerFailureKind.Auth ->
            "The coding agent's sign-in on that machine is no longer accepted." to
                "Sign it in again from this screen, or over SSH on the box."
        RunnerFailureKind.AuthRevoked ->
            "The coding agent's sign-in was revoked by the provider — a refresh cannot recover it." to
                "Sign in again to issue a new credential."
        RunnerFailureKind.Billing ->
            "The provider refused the call for lack of credit. The sign-in itself is fine." to
                "Top up or upgrade that provider account. Signing in again will not help."
        RunnerFailureKind.RateLimit ->
            "The provider throttled the request. The credential and the model are both fine." to
                "Wait for the limit to reset, then retry. Do not sign in again."
        RunnerFailureKind.ModelNotSupported ->
            "The signed-in plan does not include the selected model." to
                "Pick a different model for this machine. Signing in cannot move a model onto a plan."
        RunnerFailureKind.ModelNotFound ->
            "That model id does not resolve on this machine." to
                "Pick a model the runner lists. OpenCode ids look like <providerId>/<modelId>."
        RunnerFailureKind.ProviderKey ->
            "The provider API key for that model is missing or was rejected." to
                "Set the key on that machine. This is separate from Yaver sign-in and from the runner's OAuth."
        RunnerFailureKind.Unknown -> null
    }

    // ── 1. Capability gap ─────────────────────────────────────────────────

    /** The wire code for a missing toolchain — reason_codes.go
     *  ReasonCapabilityToolchainMissing. */
    const val CAPABILITY_TOOLCHAIN_MISSING = "capability.toolchain_missing"

    /** Parse an agent-supplied gap. Returns null for anything that is not one —
     *  a half-formed object must not render as a button that goes nowhere.
     *  Accepts an org.json.JSONObject. */
    fun parseCapabilityGap(raw: org.json.JSONObject?): CapabilityGap? {
        if (raw == null) return null
        val code = raw.optString("code")
        val summary = raw.optString("summary")
        if (code.isEmpty() || summary.isEmpty()) return null

        var fix: GapFix? = null
        raw.optJSONObject("fix")?.let { f ->
            val path = f.optString("path")
            val stream = f.optString("stream")
            val instant = f.optBoolean("instant", false)
            // No path, or no way to SEE the fix, = an action the user could
            // start and never observe. Refuse to render it. An instant fix is
            // exempt: it answers in milliseconds and re-runs the original
            // request, which is what makes it visible.
            if (path.isNotEmpty() && (stream.isNotEmpty() || instant)) {
                val label = f.optString("label")
                val method = f.optString("method")
                val est = f.optString("est")
                // Only string values survive (routes carry identifiers).
                val body: Map<String, String> = buildMap {
                    f.optJSONObject("body")?.let body@{ b ->
                        val names = b.names() ?: return@body
                        for (i in 0 until names.length()) {
                            val k = names.getString(i)
                            val v = b.opt(k)
                            if (v is String) put(k, v)
                        }
                    }
                }
                fix = GapFix(
                    label = label.ifEmpty { "Install" },
                    method = method.ifEmpty { "POST" },
                    path = path,
                    stream = stream,
                    est = est.ifEmpty { null },
                    retry = f.optBoolean("retry", false),
                    body = body,
                    instant = instant,
                )
            }
        }

        var aiFix: GapFix? = null
        raw.optJSONObject("aiFix")?.let { a ->
            val path = a.optString("path")
            if (path.isNotEmpty()) {
                val body: Map<String, String> = buildMap {
                    a.optJSONObject("body")?.let body@{ b ->
                        val names = b.names() ?: return@body
                        for (i in 0 until names.length()) {
                            val k = names.getString(i)
                            val v = b.opt(k)
                            if (v is String) put(k, v)
                        }
                    }
                }
                val label = a.optString("label")
                val method = a.optString("method")
                aiFix = GapFix(
                    label = label.ifEmpty { "Fix with the coding agent" },
                    method = method.ifEmpty { "POST" },
                    path = path,
                    stream = a.optString("stream"),
                    est = null,
                    retry = a.optBoolean("retry", false),
                    body = body,
                    instant = a.optBoolean("instant", false),
                )
            }
        }

        val detail = raw.optString("detail")
        val constraint = raw.optString("constraint")
        return CapabilityGap(
            code = code,
            capability = raw.optString("capability"),
            summary = summary,
            detail = detail.ifEmpty { null },
            fix = fix,
            constraint = constraint.ifEmpty { null },
            aiFix = aiFix,
        )
    }

    /** The gap on a JSON object body the agent returned (a /dev/start 412, a
     *  /tasks 500, or a /dev/status poll). Accepts both key spellings. */
    fun capabilityGapFromBody(body: org.json.JSONObject?): CapabilityGap? {
        if (body == null) return null
        return parseCapabilityGap(body.optJSONObject("capabilityGap")) ?: parseCapabilityGap(body.optJSONObject("gap"))
    }

    /** The gap on a /dev/events frame (`{type:"error", gap:{…}}`), or null. */
    fun capabilityGapFromDevEvent(event: org.json.JSONObject?): CapabilityGap? {
        return parseCapabilityGap(event?.optJSONObject("gap"))
    }

    /** The headline sentence. */
    fun gapTitle(gap: CapabilityGap): String = gap.summary

    /** The body: what pressing the button will do, or why there is no button. */
    fun gapBody(gap: CapabilityGap): String = gap.detail ?: gap.constraint ?: ""

    /** Button label, or null when there is no route (render `constraint`). */
    fun gapFixLabel(gap: CapabilityGap?): String? {
        val fix = gap?.fix ?: return null
        val est = fix.est?.let { " · $it" } ?: ""
        return fix.label + est
    }

    /** The path to subscribe to for the fix's live output. */
    fun gapStreamPath(gap: CapabilityGap?): String? {
        val fix = gap?.fix ?: return null
        return if (fix.stream.isNotEmpty()) "/streams/" + fix.stream else null
    }

    /** The tool name POST /install/<tool> wants, derived from the fix path. */
    fun gapInstallTool(gap: CapabilityGap?): String? {
        val fix = gap?.fix ?: return null
        val path = fix.path.trim()
        if (!path.startsWith("/install/")) return null
        var tool = path.removePrefix("/install/")
        while (tool.endsWith("/")) tool = tool.dropLast(1)
        return tool.ifEmpty { null }
    }

    /** True when the surface should re-issue the original request once the fix
     *  reports success. */
    fun gapRetriesAfterFix(gap: CapabilityGap?): Boolean = gap?.fix?.retry == true

    /** The "hand it to a coding agent" button, or null. Present only when a
     *  DETERMINISTIC fix does not exist. */
    fun gapAIFixLabel(gap: CapabilityGap?): String? {
        val g = gap ?: return null
        val ai = g.aiFix ?: return null
        if (g.fix != null) return null
        return ai.label.ifEmpty { "Fix with the coding agent" }
    }

    /** True when the fix answers synchronously: POST it, then re-run the
     *  original request. */
    fun gapFixIsInstant(gap: CapabilityGap?): Boolean = gap?.fix?.instant == true

    /** True when this surface must NOT offer a retry. A gap with a FIX has a
     *  route, and a retry beside it invites the user to press the thing that
     *  just failed; a CONSTRAINED gap states a settled fact that retrying
     *  cannot alter. */
    fun gapSuppressesRetry(gap: CapabilityGap?): Boolean {
        val g = gap ?: return false
        if (g.fix != null) return true
        if (!g.constraint.isNullOrEmpty()) return true
        return false
    }

    /** Wire code for "another surface is already previewing this project" —
     *  reason_codes.go ReasonPreviewSessionActive. */
    const val PREVIEW_SESSION_ACTIVE = "preview.session_active"

    fun isPreviewSessionActive(gap: CapabilityGap?): Boolean = gap?.code == PREVIEW_SESSION_ACTIVE

    // ── 2. Stream recovery ────────────────────────────────────────────────

    enum class StreamEndKind {
        /** A terminal `done` frame arrived — the work really finished. */
        Done,
        /** The client tore the stream down itself (left the screen). */
        Cancelled,
        /** The stream died without saying goodbye. The work is still running. */
        Interrupted,
    }

    /** An end with neither a `done` frame nor a local cancel is an
     *  INTERRUPTION, whether or not the platform reported an error. */
    fun classifyStreamEnd(sawDone: Boolean, cancelled: Boolean): StreamEndKind {
        if (sawDone) return StreamEndKind.Done
        if (cancelled) return StreamEndKind.Cancelled
        return StreamEndKind.Interrupted
    }

    /** Reattach attempts before we stop and hand the user a button. */
    const val MAX_REATTACH_ATTEMPTS = 5

    /** Bounded backoff: 1s, 2s, 4s, 8s, then 15s. */
    fun reattachDelayMs(attempt: Int): Int {
        val ladder = listOf(1000, 2000, 4000, 8000, 15000)
        val idx = attempt.coerceIn(0, ladder.size - 1)
        return ladder[idx]
    }

    sealed class StreamRecoveryPlan {
        /** Nothing to do — the stream ended the way it was supposed to. */
        object Idle : StreamRecoveryPlan()
        data class Reattach(val attempt: Int, val delayMs: Int, val message: String) : StreamRecoveryPlan()
        data class GiveUp(val message: String) : StreamRecoveryPlan()
    }

    private fun withCause(sentence: String, cause: String?): String {
        val trimmed = (cause ?: "").trim()
        return if (trimmed.isEmpty()) sentence else "$sentence ($trimmed)"
    }

    /** What to do about a stream that ended, and what to SAY while doing it.
     *  The give-up sentence carries the fact the user most needs and is least
     *  likely to assume: a dead stream is not dead work. */
    fun planStreamRecovery(end: StreamEndKind, attempt: Int, cause: String? = null): StreamRecoveryPlan {
        if (end != StreamEndKind.Interrupted) return StreamRecoveryPlan.Idle
        if (attempt >= MAX_REATTACH_ATTEMPTS) {
            return StreamRecoveryPlan.GiveUp(
                withCause(
                    "Live output stopped and could not be picked back up after $MAX_REATTACH_ATTEMPTS attempts. " +
                        "The work is still running on the box — this is the stream, not the work. " +
                        "Use Try again to reattach, or reconnect if the box itself is unreachable.",
                    cause,
                )
            )
        }
        return StreamRecoveryPlan.Reattach(
            attempt = attempt + 1,
            delayMs = reattachDelayMs(attempt),
            message = withCause(
                "Live output stopped — reattaching (${attempt + 1} of $MAX_REATTACH_ATTEMPTS)… " +
                    "The work is still running on the box.",
                cause,
            ),
        )
    }

    // ── 3. Relay deny ─────────────────────────────────────────────────────

    /** Named remedy for a TERMINAL relay deny — one where retrying cannot
     *  help. device_mismatch is the one relay-auth failure that can never
     *  self-heal (the box belongs to a different account). */
    fun explainRelayDeny(cause: String?): String? {
        val lower = (cause ?: "").lowercase()
        if (lower.contains("reason=device_mismatch") || lower.contains("does not own this deviceid")) {
            return "The relay refused this device: it is signed in as a different Yaver account " +
                "than this one (reason=device_mismatch). Retrying can't help — run `yaver auth` " +
                "on the box to sign it into this account, or switch here to the account the box uses."
        }
        return null
    }

    private val BANDWIDTH_RE = Pattern.compile(
        "bandwidth limit exceeded: (\\d+)MB used of (\\d+)MB daily limit",
        Pattern.CASE_INSENSITIVE,
    )

    /** Compact named card for relay free-tier / bandwidth limits. */
    fun classifyRelayLimit(message: String?): RelayLimitCard? {
        val raw = message ?: ""
        val lower = raw.lowercase()

        BANDWIDTH_RE.matcher(raw).let { m ->
            if (m.find()) {
                val used = m.group(1)
                val limit = m.group(2)
                return RelayLimitCard(
                    kind = "bandwidth-cap",
                    title = "Daily relay bandwidth cap reached",
                    detail = "This device moved $used MB of its $limit MB daily relay allowance. " +
                        "The cap resets daily. Direct LAN and tunnel connections are unmetered — " +
                        "use one of those, or wait for the reset. A stream that stops mid-way with " +
                        "this message was cut by the cap, not by your network.",
                )
            }
        }
        if (lower.contains("free relay user rate limit exceeded")) {
            return RelayLimitCard(
                kind = "free-tier-rate",
                title = "Relay free-tier rate limit",
                detail = "The shared relay is rate-limiting this account's requests. This clears by " +
                    "itself within a minute — sustained heavy use is better served by a direct " +
                    "LAN or tunnel connection, which is never rate-limited.",
            )
        }
        if (lower.contains("rate limit exceeded")) {
            return RelayLimitCard(
                kind = "rate-limit",
                title = "Relay rate limit",
                detail = "The relay is rate-limiting requests from this network right now. Wait a " +
                    "moment and retry; direct LAN and tunnel connections are unaffected.",
            )
        }
        return null
    }

    // ── 4. Runner auth ────────────────────────────────────────────────────

    /** The statuses a runner browser-auth session can END on. Polling past any
     *  of these is the "spinner over a decided outcome" defect. */
    fun isRunnerAuthTerminal(status: String?): Boolean = when (status?.lowercase()) {
        "completed", "failed", "cancelled", "canceled", "error", "account_not_eligible" -> true
        else -> false
    }

    /** The sentence for a terminal runner-auth outcome, or null while it runs.
     *  `account_not_eligible` is the one terminal state where "try again" is a
     *  lie: the sign-in WORKED, the account simply has no eligible
     *  subscription. */
    fun explainRunnerAuthOutcome(status: String?, runnerLabel: String, error: String?, detail: String?): String? {
        val s = status?.lowercase() ?: ""
        if (!isRunnerAuthTerminal(s)) return null
        if (s == "account_not_eligible") {
            val verdict = firstNonEmpty(detail, error)
            val base = "The sign-in itself worked — this account has no eligible subscription for " +
                "$runnerLabel. Retrying with the same account cannot succeed; sign in with " +
                "a different account."
            return if (verdict.isEmpty()) base else "$base ($verdict)"
        }
        if (s == "completed") return null
        val verdict = firstNonEmpty(error, detail)
        return if (verdict.isEmpty()) "$runnerLabel auth ended with $s." else verdict
    }

    /** True when the outcome is one a retry can never change. */
    fun runnerAuthRetryIsFutile(status: String?): Boolean =
        status?.lowercase() == "account_not_eligible"

    /** The anti-spinner narration for a PENDING browser-auth session. The
     *  agent stamps `lastOutputAt` on every line the spawned CLI prints. */
    fun runnerAuthLivenessLine(nowMs: Long, startedAtMs: Long?, lastOutputAtMs: Long?): String? {
        val startedAt = startedAtMs ?: return null
        if (startedAt <= 0 || nowMs < startedAt) return null
        val started = "Started ${shortDuration(nowMs - startedAt)} ago"
        val last = lastOutputAtMs
        if (last != null && last >= startedAt) {
            return "$started · CLI last output ${shortDuration(nowMs - last)} ago"
        }
        return "$started · the CLI has printed nothing yet"
    }

    /** "42s" / "2m 14s", from milliseconds. */
    fun shortDuration(ms: Long): String {
        val s = maxOf(0, (ms / 1000).toInt())
        if (s < 60) return "${s}s"
        return "${s / 60}m ${s % 60}s"
    }

    // ── 5. Client-side refusals ───────────────────────────────────────────

    /** Why this device refused the request itself, or null if the failure was
     *  (or may have been) on the wire. Deliberately conservative: naming the
     *  wrong cause is worse than naming none. On Android the relevant class is
     *  cleartext / TLS to the LAN host — mapped from the exception type since
     *  Android has no per-code ATS domain. */
    fun clientPolicyReason(e: Throwable): String? {
        // OkHttp throws UnknownServiceException for cleartext blocks; TLS
        // handshake failures surface as SSLHandshakeException / SSLException.
        val name = e.javaClass.simpleName
        return when {
            name.contains("UnknownService") ->
                "This device's network security policy refused the cleartext connection before it left the " +
                    "device — the box was never contacted. Overlay addresses (Tailscale 100.64/10, Yaver Mesh " +
                    "100.96/12) are HTTP on the LAN; the app allows cleartext so this usually means the host " +
                    "is not a LAN box."
            name.contains("SSL") ->
                "This device rejected the box's TLS certificate, so the request never completed. " +
                    "The box itself may be perfectly healthy."
            else -> null
        }
    }

    /** Does this reason mean waking the box cannot help? */
    fun isClientBlocked(reason: String?): Boolean = !reason.isNullOrEmpty()

    private fun firstNonEmpty(vararg values: String?): String {
        for (v in values) {
            val t = (v ?: "").trim()
            if (t.isNotEmpty()) return t
        }
        return ""
    }
}
