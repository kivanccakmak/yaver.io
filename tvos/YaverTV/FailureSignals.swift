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
