// FailureSignals.swift — the tvOS port of the four named-failure seams that
// shipped to mobile and web on 2026-07-26/27 and reached no native surface.
//
// WHY THIS FILE EXISTS. Cross-surface parity (CLAUDE.md): "a fix is not done
// until it exists on all surfaces", and native surfaces do NOT inherit the RN
// fix — they have their own code and must be ported explicitly. Four signals
// landed as TypeScript twins (mobile/src/lib + web/lib) and stopped there:
//
//   1. capabilityGap.ts        — a missing toolchain, NAMED, with a tappable
//                                install route and a stream to watch it run.
//   2. taskStreamRecovery.ts   — a stream that ended without a `done` frame is
//                                an INTERRUPTION, not a finish; reattach and
//                                say so.
//   3. relayDeny.ts            — the relay's verdicts (device_mismatch, free
//                                tier, bandwidth cap) rendered as themselves
//                                instead of generic unreachability.
//   4. runnerAuthFlow.ts       — `account_not_eligible` is TERMINAL, and a
//                                pending auth session must narrate its wait.
//
// Every sentence below is copied from its TypeScript twin on purpose. A user
// who reads one wording on their phone and a different wording on the TV
// learns that Yaver's diagnosis depends on which screen they picked up, which
// is the opposite of what a named cause is for. When you change a sentence
// there, change it here.
//
// PURE BY CONSTRUCTION: Foundation only, no SwiftUI, no URLSession, no actor.
// That is what makes it verifiable without an Apple TV — see
// tvos/README.md ("Verifying FailureSignals"). tvos/ has no XCTest target
// (tvos/project.yml declares one application target and nothing else), so the
// proof is a standalone `swiftc` run against FailureSignalsChecks.swift.

import Foundation

/// The slice of AgentClient's error this file needs.
///
/// FailureSignals is documented as Foundation-only so `swiftc` alone can prove
/// it, without Xcode, a simulator, or an Apple TV (tvos/README.md). That
/// property had ROTTED: a direct reference to the concrete `AgentError` pulled
/// in AgentClient.swift, which pulls BoxTarget, and the README's own verify
/// command stopped compiling — so nobody had been running the checks it
/// promises. Depending on a local protocol instead restores it; AgentError
/// conforms in one line and gains nothing it did not already have.
protocol AgentErrorCoded: Error {
    var code: String? { get }
    var message: String { get }
}

/// The ROUTE a capability gap carries. method + path + stream is what makes a
/// remedy tappable rather than a sentence about a remedy.
struct GapFix: Equatable, Sendable {
    let label: String
    let method: String
    let path: String
    /// log-stream NAME, e.g. "install:flutter"; served at GET /streams/<stream>
    let stream: String
    let est: String?
    let retry: Bool
}

/// "This machine is missing something, and here is the tap that fixes it."
/// Produced by desktop/agent/capability_gap.go on three channels — the
/// /dev/start 412 body, the /dev/events SSE `error` frame, and /dev/status —
/// as the SAME object.
struct CapabilityGap: Equatable, Sendable {
    let code: String
    let capability: String
    let summary: String
    let detail: String?
    /// nil ⇒ no fixer exists here; `constraint` says why.
    let fix: GapFix?
    let constraint: String?
}

/// Named relay limit verdict (the monetization boundary, rendered as itself).
struct RelayLimitCard: Equatable, Sendable {
    let kind: String   // "free-tier-rate" | "bandwidth-cap" | "rate-limit"
    let title: String
    let detail: String
}

enum FailureSignals {

    // ── 0. Session scope denial ───────────────────────────────────────────

    /// Wire code for "this session token's companion scope forbids this
    /// endpoint" — reason_codes.go ReasonAuthSessionScopeDenied. A scope 403
    /// is NEVER retryable from the TV: the allowlist lives in the agent, so
    /// hitting one means the box runs an agent older than this app. The route
    /// is an agent update, not a Try again.
    static let sessionScopeDenied = "auth.session.scope_denied"

    /// Code-first, with ONE prose shim for agents that predate the code
    /// (they emit only "TV-scoped token cannot access this endpoint" —
    /// httpserver.go companionScopeDeniedMessage). The shim lives here and
    /// nowhere else; do not copy the string into a view.
    static func isSessionScopeDenied(_ error: Error) -> Bool {
        if let agentError = error as? AgentErrorCoded {
            if agentError.code == sessionScopeDenied { return true }
            if agentError.message.contains("scoped token cannot access this endpoint") { return true }
        }
        return false
    }

    /// The sentence + route for a scope denial, in TV words.
    static func explainSessionScopeDenied() -> String {
        "The agent on this box is older than this TV app, so it refuses the preview endpoints. Update the agent and this screen will work."
    }

    // ── 0b. Runner/render target probe failures ───────────────────────────

    /// Mirror of web/lib/runtimeTargetProbeFailure.ts — the SAME policy, keyed
    /// off the same relay reason codes, so the TV and the dashboard route a
    /// dead render leg identically. Port the policy, never the regexes-of-the-
    /// day: if a new relay verdict appears, it gets a code in the agent and a
    /// row here AND there in one change.
    enum TargetProbeKind: String, Sendable {
        // Raw values are the CROSS-SURFACE names — they must match
        // web/lib/runtimeTargetProbeFailure.ts exactly. This one said
        // "relay-auth" while web said "auth", and the parity guard missed it
        // because it asked whether the source *contained* "auth" — which
        // "relay-auth" does. Two surfaces naming one failure differently is the
        // drift that guard exists to catch, so it now compares whole values.
        case relayAuth = "auth"
        case relayPresence = "relay-presence"
        case relayRoute = "relay-route"
        case agentVerbSkew = "agent-verb-skew"
        case projectMissing = "project-missing"
        case other
    }

    struct TargetProbePlan: Equatable, Sendable {
        let kind: TargetProbeKind
        let retry: Bool
        let useRunnerFallback: Bool
        let showFixWithRunner: Bool
    }

    static let relayDeviceNotConnectedCode = "relay.device_not_connected"
    static let relayDeviceNotConnectedReason = "connectivity.relay.device_not_connected"
    /// Mirrors ReasonProjectNotOnThisMachine (desktop/agent/project_missing_reply.go)
    /// and PROJECT_NOT_ON_THIS_MACHINE_CODE (web/lib/runtimeTargetProbeFailure.ts).
    static let projectNotOnThisMachineCode = "project_not_on_this_machine"

    /// A relay CREDENTIAL refusal — the account's relay password is missing or
    /// stale. Self-healable and emphatically not the agent's fault, so it must
    /// never reach a coding runner.
    private static func isRelayCredentialFailure(_ lower: String) -> Bool {
        lower.contains("relay_password_missing")
            || lower.contains("relay_password_invalid")
            || lower.contains("relay_password_rate_limited")
            || lower.contains("relay password missing")
            || lower.contains("invalid relay password")
            || lower.contains("relay password mismatch")
            || lower.contains("too many invalid relay password attempts")
            || lower.contains("reason=bad_password")
            || lower.contains("relay authentication failed")
    }

    static func classifyTargetProbeFailure(_ error: String?) -> TargetProbePlan {
        let lower = (error ?? "").lowercased()
        if isRelayCredentialFailure(lower) {
            return TargetProbePlan(kind: .relayAuth, retry: true, useRunnerFallback: false, showFixWithRunner: false)
        }
        // An /ops verb the agent has never heard of is VERSION SKEW — the
        // client shipped a call the installed agent predates. Deterministic fix
        // (update the agent), so never route it to a coding runner: an LLM
        // cannot add a verb to a released binary, and one such escalation
        // already burned 121k tokens grepping the wrong repo (2026-07-28).
        if lower.contains("unknown_verb") || lower.contains("unknown verb") {
            return TargetProbePlan(kind: .agentVerbSkew, retry: true, useRunnerFallback: false, showFixWithRunner: false)
        }
        if lower.contains(relayDeviceNotConnectedCode)
            || lower.contains(relayDeviceNotConnectedReason)
            || lower.contains("device not connected to relay") {
            return TargetProbePlan(kind: .relayPresence, retry: true, useRunnerFallback: true, showFixWithRunner: false)
        }
        if lower.contains("only reachable over a relay") {
            return TargetProbePlan(kind: .relayRoute, retry: true, useRunnerFallback: true, showFixWithRunner: false)
        }
        if lower.contains("render_unreachable")
            || (lower.contains("render machine") && lower.contains("not reachable"))
            || (lower.contains("runner/render split") && lower.contains("not reachable")) {
            return TargetProbePlan(kind: .relayPresence, retry: true, useRunnerFallback: true, showFixWithRunner: false)
        }
        // The project is simply not on the render box. Deterministic: a coding
        // agent cannot create a directory on a machine it is not running on,
        // and asking it to burns a real LLM run (2026-08-02 cascade). Code
        // first, prose fallback for agents older than that change.
        if lower.contains(projectNotOnThisMachineCode)
            || lower.contains("on this machine — check")
            || lower.contains("on this machine - check")
            || (lower.contains("no mobile project named") && lower.contains("on this machine")) {
            return TargetProbePlan(kind: .projectMissing, retry: false, useRunnerFallback: true, showFixWithRunner: false)
        }
        return TargetProbePlan(kind: .other, retry: false, useRunnerFallback: false, showFixWithRunner: true)
    }

    /// What to SAY when the relay has no tunnel to the box.
    ///
    /// classifyTargetProbeFailure already recognises this case, but a plan with
    /// no sentence leaves the TV rendering a generic failure for a cause we
    /// have precisely identified. Copied verbatim from
    /// web/lib/relayAuth.ts::RELAY_TUNNEL_DOWN_REMEDY and its mobile twin — a
    /// user who reads one diagnosis on their phone and a different one on the
    /// TV learns that Yaver's answer depends on which screen they picked up.
    ///
    /// It deliberately does NOT offer re-auth from another surface: that flow
    /// travels through the very tunnel that is missing. The only lever is on
    /// the machine itself.
    static let relayTunnelDownRemedy =
        "The relay is up but has no tunnel to this machine, so nothing reached the agent. "
        + "That is what a box with an expired session looks like from here — it cannot register with the relay. "
        + "Run `yaver auth` on the machine itself; re-auth from the web rides the tunnel that is missing."

    /// The TV sentence for a target-probe verdict, or nil when there is nothing
    /// worth saying. Native surfaces cannot import web/lib, so this is a PORT,
    /// not a shared module — keep it in step with the web copy by hand and let
    /// the parity script below catch drift.
    static func explainTargetProbe(_ plan: TargetProbePlan, renderBox: String?, runnerBox: String?) -> String? {
        let render = (renderBox?.isEmpty == false) ? renderBox! : "the render machine"
        switch plan.kind {
        case .relayAuth:
            return "The relay refused this account's credentials, so the probe never reached \(render). Sign in again and retry — the box itself is fine."
        case .relayPresence:
            return "\(render) has no live relay connection, so the target probe never reached it. Bring that box online, or pick a different render machine."
        case .relayRoute:
            return "\(render) is only reachable over a relay from here, and that route is not available right now."
        case .agentVerbSkew:
            return "The agent on \(render) is older than this TV app and does not know the call it just received. Update it with `npm install -g yaver-cli@latest`, then retry."
        case .projectMissing:
            if let runner = runnerBox, !runner.isEmpty {
                return "\(render) has no project by that name. The project list came from \(runner) — render there, or pick a project \(render) itself reports."
            }
            return "\(render) has no project by that name, so there is nothing there to render — the box itself is fine."
        case .other:
            return nil
        }
    }

    // ── 0c. Runner failure kinds ──────────────────────────────────────────
    //
    // Mirrors docs/architecture/FAILURE_SIGNALS.json — the canonical table every
    // surface embeds. Native surfaces cannot import web/lib, so this is a copy;
    // web/lib/failureSignalParity.test.ts fails when it drifts.
    //
    // THE LAW: a failure that is not about the credential must never route the
    // user into a sign-in flow. Billing, throttling, model entitlement and a
    // missing provider key are all VALID credentials failing for other reasons.
    // Sending someone through OAuth for any of them is a dead end — and in the
    // rate-limit case it also throws away a working session for nothing.
    enum RunnerFailureKind: String, Sendable {
        case auth
        case authRevoked = "auth-revoked"
        case billing
        case rateLimit = "rate-limit"
        case modelNotSupported = "model-not-supported"
        case modelNotFound = "model-not-found"
        case providerKey = "provider-key"
        case unknown
    }

    /// Classify runner output. Ordered most-specific first: the generic auth
    /// matcher would otherwise swallow billing and throttling, which is exactly
    /// how a valid credential ended up being told to sign in again.
    static func classifyRunnerFailure(_ output: String?) -> RunnerFailureKind {
        let m = (output ?? "").lowercased()
        if m.isEmpty { return .unknown }

        if m.contains("credit balance is too low") || m.contains("credit_balance_too_low")
            || m.contains("plans & billing") { return .billing }
        if m.contains("rate_limit_error") || m.contains("rate limit reached")
            || m.contains("rate limit exceeded") || m.contains("too many requests") { return .rateLimit }
        if m.contains("ai_loadapikeyerror") || m.contains("api key is missing")
            || m.contains("load api key") { return .providerKey }
        if m.contains("model is not supported") || m.contains("does not have access to model")
            || m.contains("unsupported model") { return .modelNotSupported }
        if m.contains("providermodelnotfounderror") || m.contains("provider model not found")
            || m.contains("invalid model") { return .modelNotFound }
        if m.contains("oauth access token has been revoked") || m.contains("token has been revoked") {
            return .authRevoked
        }
        if m.contains("oauth token has expired") || m.contains("oauth session expired")
            || m.contains("authentication_error") || m.contains("authentication_failed")
            || m.contains("not authenticated") || m.contains("not logged in")
            || m.contains("please sign in") || m.contains("invalid bearer token")
            || m.contains("unauthorized") || m.contains("expired token")
            || m.contains("token_expired") || m.contains("please run /login")
            || m.contains("run codex login") || m.contains("codex login --device-auth")
            || m.contains("refresh_token_reused") { return .auth }
        return .unknown
    }

    /// True only when signing the runner in again can actually fix it. A TV
    /// showing a sign-in QR for an out-of-credit account wastes the one
    /// interaction the surface has.
    static func runnerFailureRoutesToSignIn(_ kind: RunnerFailureKind) -> Bool {
        kind == .auth || kind == .authRevoked
    }

    /// The sentence + action in TV words, or nil when there is nothing to say.
    static func explainRunnerFailure(_ kind: RunnerFailureKind) -> (reason: String, action: String)? {
        switch kind {
        case .auth:
            return ("The coding agent's sign-in on that machine is no longer accepted.",
                    "Sign it in again from this screen, or over SSH on the box.")
        case .authRevoked:
            return ("The coding agent's sign-in was revoked by the provider — a refresh cannot recover it.",
                    "Sign in again to issue a new credential.")
        case .billing:
            return ("The provider refused the call for lack of credit. The sign-in itself is fine.",
                    "Top up or upgrade that provider account. Signing in again will not help.")
        case .rateLimit:
            return ("The provider throttled the request. The credential and the model are both fine.",
                    "Wait for the limit to reset, then retry. Do not sign in again.")
        case .modelNotSupported:
            return ("The signed-in plan does not include the selected model.",
                    "Pick a different model for this machine. Signing in cannot move a model onto a plan.")
        case .modelNotFound:
            return ("That model id does not resolve on this machine.",
                    "Pick a model the runner lists. OpenCode ids look like <providerId>/<modelId>.")
        case .providerKey:
            return ("The provider API key for that model is missing or was rejected.",
                    "Set the key on that machine. This is separate from Yaver sign-in and from the runner's OAuth.")
        case .unknown:
            return nil
        }
    }

    // ── 1. Capability gap ─────────────────────────────────────────────────

    /// The wire code for a missing toolchain. Mirrors
    /// desktop/agent/reason_codes.go ReasonCapabilityToolchainMissing.
    static let capabilityToolchainMissing = "capability.toolchain_missing"

    private static func str(_ v: Any?) -> String {
        (v as? String) ?? ""
    }

    /// Parse an agent-supplied gap. Returns nil for anything that is not one —
    /// a half-formed object must not render as a button that goes nowhere.
    static func parseCapabilityGap(_ raw: Any?) -> CapabilityGap? {
        guard let o = raw as? [String: Any] else { return nil }
        let code = str(o["code"])
        let summary = str(o["summary"])
        if code.isEmpty || summary.isEmpty { return nil }

        var fix: GapFix?
        if let f = o["fix"] as? [String: Any] {
            let path = str(f["path"])
            let stream = str(f["stream"])
            // No path or no stream = an install the user could start and never
            // see. That is the "silent 1.2 GB download" defect; refuse to
            // render it.
            if !path.isEmpty && !stream.isEmpty {
                let label = str(f["label"])
                let method = str(f["method"])
                let est = str(f["est"])
                fix = GapFix(
                    label: label.isEmpty ? "Install" : label,
                    method: method.isEmpty ? "POST" : method,
                    path: path,
                    stream: stream,
                    est: est.isEmpty ? nil : est,
                    retry: (f["retry"] as? Bool) == true
                )
            }
        }

        let detail = str(o["detail"])
        let constraint = str(o["constraint"])
        return CapabilityGap(
            code: code,
            capability: str(o["capability"]),
            summary: summary,
            detail: detail.isEmpty ? nil : detail,
            fix: fix,
            constraint: constraint.isEmpty ? nil : constraint
        )
    }

    /// The gap on a JSON body the agent returned (a /dev/start 412, a /tasks
    /// 500 or 201-with-status-failed, or a /dev/status poll). Accepts both key
    /// spellings the agent uses so no call site has to remember which.
    static func capabilityGapFromBody(_ body: Any?) -> CapabilityGap? {
        guard let o = body as? [String: Any] else { return nil }
        return parseCapabilityGap(o["capabilityGap"]) ?? parseCapabilityGap(o["gap"])
    }

    /// The gap on a /dev/events frame (`{type:"error", gap:{…}}`), or nil.
    static func capabilityGapFromDevEvent(_ event: Any?) -> CapabilityGap? {
        guard let o = event as? [String: Any] else { return nil }
        return parseCapabilityGap(o["gap"])
    }

    /// Parse straight from raw response bytes; nil when the body is not JSON.
    static func capabilityGapFromData(_ data: Data) -> CapabilityGap? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return capabilityGapFromBody(obj)
    }

    /// The headline sentence.
    static func gapTitle(_ gap: CapabilityGap) -> String { gap.summary }

    /// The body: what pressing the button will do, or why there is no button.
    static func gapBody(_ gap: CapabilityGap) -> String {
        gap.detail ?? gap.constraint ?? ""
    }

    /// Button label, or nil when there is no route (render `constraint`).
    static func gapFixLabel(_ gap: CapabilityGap?) -> String? {
        guard let fix = gap?.fix else { return nil }
        let est = fix.est.map { " · \($0)" } ?? ""
        return fix.label + est
    }

    /// The path to subscribe to for the fix's live output, relative to the agent.
    static func gapStreamPath(_ gap: CapabilityGap?) -> String? {
        guard let fix = gap?.fix, !fix.stream.isEmpty else { return nil }
        return "/streams/" + fix.stream
    }

    /// The tool name POST /install/<tool> wants, derived from the fix path so
    /// no caller re-parses it. Nil when the fix is not an install route.
    static func gapInstallTool(_ gap: CapabilityGap?) -> String? {
        guard let fix = gap?.fix else { return nil }
        let path = fix.path.trimmingCharacters(in: .whitespaces)
        guard path.hasPrefix("/install/") else { return nil }
        var tool = String(path.dropFirst("/install/".count))
        while tool.hasSuffix("/") { tool.removeLast() }
        return tool.isEmpty ? nil : tool
    }

    /// True when the surface should re-issue the original request once the fix
    /// reports success — "return them to what they were doing".
    static func gapRetriesAfterFix(_ gap: CapabilityGap?) -> Bool {
        gap?.fix?.retry == true
    }

    // ── 2. Stream recovery ────────────────────────────────────────────────

    /// How an event/output stream ended.
    enum StreamEndKind: Sendable {
        /// A terminal `done` frame arrived — the work really finished.
        case done
        /// The client tore the stream down itself (left the screen).
        case cancelled
        /// The stream died without saying goodbye. The work is still running.
        case interrupted
    }

    /// An end with neither a `done` frame nor a local cancel is an
    /// INTERRUPTION, whether or not the platform bothered to report an error.
    /// A clean EOF on an SSE stream that should never close is exactly what a
    /// dropped relay tunnel looks like — treating "no error object" as "fine"
    /// is how the frozen log panel shipped.
    static func classifyStreamEnd(sawDone: Bool, cancelled: Bool) -> StreamEndKind {
        if sawDone { return .done }
        if cancelled { return .cancelled }
        return .interrupted
    }

    /// Reattach attempts before we stop and hand the user a button.
    static let maxReattachAttempts = 5

    /// Bounded backoff: 1s, 2s, 4s, 8s, then 15s. A relay bounce heals in
    /// seconds, so the first rungs are fast; the cap keeps a genuinely-down box
    /// from being hammered.
    static func reattachDelayMs(_ attempt: Int) -> Int {
        let ladder = [1000, 2000, 4000, 8000, 15000]
        let idx = max(0, min(attempt, ladder.count - 1))
        return ladder[idx]
    }

    enum StreamRecoveryPlan: Equatable {
        /// Nothing to do — the stream ended the way it was supposed to.
        case idle
        case reattach(attempt: Int, delayMs: Int, message: String)
        case giveUp(message: String)
    }

    private static func withCause(_ sentence: String, _ cause: String?) -> String {
        let trimmed = (cause ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? sentence : "\(sentence) (\(trimmed))"
    }

    /// What to do about a stream that ended, and what to SAY while doing it.
    ///
    /// The give-up sentence carries the fact the user most needs and is least
    /// likely to assume: a dead stream is not dead work. The box keeps going,
    /// so the route back is "reattach", not "start over".
    static func planStreamRecovery(
        end: StreamEndKind,
        attempt: Int,
        maxAttempts: Int = maxReattachAttempts,
        cause: String? = nil
    ) -> StreamRecoveryPlan {
        guard end == .interrupted else { return .idle }
        if attempt >= maxAttempts {
            return .giveUp(message: withCause(
                "Live output stopped and could not be picked back up after \(maxAttempts) attempts. " +
                "The work is still running on the box — this is the stream, not the work. " +
                "Use Try again to reattach, or reconnect if the box itself is unreachable.",
                cause
            ))
        }
        return .reattach(
            attempt: attempt,
            delayMs: reattachDelayMs(attempt),
            message: withCause(
                "Live output stopped — reattaching (\(attempt + 1) of \(maxAttempts))… " +
                "The work is still running on the box.",
                cause
            )
        )
    }

    // ── 3. Relay deny ─────────────────────────────────────────────────────

    /// Named remedy for a TERMINAL relay deny — one where retrying cannot
    /// help. Returns nil for anything a retry/repair rung might still fix.
    ///
    /// device_mismatch is the one relay-auth failure that can never self-heal
    /// (the box belongs to a different account) — and it was also the one no UI
    /// named, so it looped as "Reconnecting" forever.
    static func explainRelayDeny(_ cause: String?) -> String? {
        let lower = (cause ?? "").lowercased()
        if lower.contains("reason=device_mismatch") || lower.contains("does not own this deviceid") {
            return "The relay refused this device: it is signed in as a different Yaver account " +
                   "than this one (reason=device_mismatch). Retrying can't help — run `yaver auth` " +
                   "on the box to sign it into this account, or switch here to the account the box uses."
        }
        return nil
    }

    /// Compact named card for relay free-tier / bandwidth limits. Returns nil
    /// when the message is not a limit verdict.
    static func classifyRelayLimit(_ message: String?) -> RelayLimitCard? {
        let raw = message ?? ""
        let lower = raw.lowercased()

        if let m = firstBandwidthMatch(raw) {
            return RelayLimitCard(
                kind: "bandwidth-cap",
                title: "Daily relay bandwidth cap reached",
                detail: "This device moved \(m.used) MB of its \(m.limit) MB daily relay allowance. " +
                        "The cap resets daily. Direct LAN and tunnel connections are unmetered — " +
                        "use one of those, or wait for the reset. A stream that stops mid-way with " +
                        "this message was cut by the cap, not by your network."
            )
        }
        if lower.contains("free relay user rate limit exceeded") {
            return RelayLimitCard(
                kind: "free-tier-rate",
                title: "Relay free-tier rate limit",
                detail: "The shared relay is rate-limiting this account's requests. This clears by " +
                        "itself within a minute — sustained heavy use is better served by a direct " +
                        "LAN or tunnel connection, which is never rate-limited."
            )
        }
        if lower.contains("rate limit exceeded") {
            return RelayLimitCard(
                kind: "rate-limit",
                title: "Relay rate limit",
                detail: "The relay is rate-limiting requests from this network right now. Wait a " +
                        "moment and retry; direct LAN and tunnel connections are unaffected."
            )
        }
        return nil
    }

    /// `bandwidth limit exceeded: <n>MB used of <n>MB daily limit`, as the
    /// relay writes it (relay/server.go). NSRegularExpression rather than a
    /// hand-rolled scan so the pattern stays legible next to the TS twin's.
    private static func firstBandwidthMatch(_ raw: String) -> (used: String, limit: String)? {
        let pattern = "bandwidth limit exceeded: (\\d+)MB used of (\\d+)MB daily limit"
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        guard let m = re.firstMatch(in: raw, options: [], range: range),
              m.numberOfRanges >= 3,
              let r1 = Range(m.range(at: 1), in: raw),
              let r2 = Range(m.range(at: 2), in: raw)
        else { return nil }
        return (String(raw[r1]), String(raw[r2]))
    }

    // ── 4. Runner auth ────────────────────────────────────────────────────

    /// The statuses a runner browser-auth session can END on. Polling past any
    /// of these is the "spinner over a decided outcome" defect — and
    /// `account_not_eligible` was missing from tvOS's terminal set entirely,
    /// so an ineligible account polled forever showing "pending".
    /// Mirrors desktop/agent/runner_auth_browser_http.go and
    /// web/lib/agent-client.ts::isRunnerBrowserAuthTerminal.
    static func isRunnerAuthTerminal(_ status: String?) -> Bool {
        switch (status ?? "").lowercased() {
        case "completed", "failed", "cancelled", "canceled", "error", "account_not_eligible":
            return true
        default:
            return false
        }
    }

    /// The sentence for a terminal runner-auth outcome, or nil while it runs.
    ///
    /// `account_not_eligible` is the one terminal state where "try again" is a
    /// lie: the sign-in WORKED, the account simply has no eligible
    /// subscription. Offering a retry there costs the user another round trip
    /// to learn the same thing.
    static func explainRunnerAuthOutcome(
        status: String?,
        runnerLabel: String,
        error: String?,
        detail: String?
    ) -> String? {
        let s = (status ?? "").lowercased()
        guard isRunnerAuthTerminal(s) else { return nil }
        if s == "account_not_eligible" {
            let verdict = firstNonEmpty(detail, error)
            let base = "The sign-in itself worked — this account has no eligible subscription for " +
                       "\(runnerLabel). Retrying with the same account cannot succeed; sign in with " +
                       "a different account."
            return verdict.isEmpty ? base : "\(base) (\(verdict))"
        }
        if s == "completed" { return nil }
        let verdict = firstNonEmpty(error, detail)
        return verdict.isEmpty ? "\(runnerLabel) auth ended with \(s)." : verdict
    }

    /// True when the outcome is one a retry can never change — the surface
    /// should not offer "Try again".
    static func runnerAuthRetryIsFutile(_ status: String?) -> Bool {
        (status ?? "").lowercased() == "account_not_eligible"
    }

    /// The anti-spinner narration for a PENDING browser-auth session. The
    /// agent stamps `lastOutputAt` on every line the spawned CLI prints; every
    /// wait the product imposes must narrate itself. Returns nil when there is
    /// nothing truthful to say.
    static func runnerAuthLivenessLine(
        now: Double,
        startedAt: Double?,
        lastOutputAt: Double?
    ) -> String? {
        guard let startedAt, startedAt > 0, now >= startedAt else { return nil }
        let started = "Started \(shortDuration(now - startedAt)) ago"
        if let lastOutputAt, lastOutputAt >= startedAt {
            return "\(started) · CLI last output \(shortDuration(now - lastOutputAt)) ago"
        }
        return "\(started) · the CLI has printed nothing yet"
    }

    /// "42s" / "2m 14s", from milliseconds. Same shape as the web twin.
    static func shortDuration(_ ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }

    private static func firstNonEmpty(_ values: String?...) -> String {
        for v in values {
            let t = (v ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return ""
    }
}
