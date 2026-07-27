// FailureSignalsChecks.swift — the proof for tvos/YaverTV/FailureSignals.swift.
//
// WHY THIS IS NOT AN XCTEST. `tvos/project.yml` declares exactly one target
// (the YaverTV application) and no test target, and the generated .xcodeproj is
// gitignored — so there is nowhere in this repo for an XCTest to live that CI
// or a reviewer could run without first standing up an Xcode test target.
// FailureSignals.swift is deliberately Foundation-only for exactly this reason:
// it can be compiled and executed by the Swift toolchain alone.
//
// RUN IT (from the repo root, ~2s, no Xcode project, no simulator):
//
//   swiftc -O -parse-as-library \
//          tvos/YaverTV/FailureSignals.swift \
//          tvos/Checks/FailureSignalsChecks.swift \
//          -o /tmp/yaver-tv-checks && /tmp/yaver-tv-checks
//
// Exits non-zero and prints the failing check on any regression.
//
// This file lives OUTSIDE `tvos/YaverTV/` on purpose: the XcodeGen spec globs
// that whole directory into the shipping app, and a `main()` in the app target
// is a link error. Do not move it in.
//
// PROVE THE GUARD (CLAUDE.md: "a guard you have not seen fail is a guess") —
// each of these was run against a deliberately broken FailureSignals.swift and
// observed to fail before being committed:
//   • drop `account_not_eligible` from isRunnerAuthTerminal → check 27 fails.
//   • make classifyStreamEnd return .done when there is no error object →
//     check 12 fails (this is the exact shape of the shipped freeze).
//   • accept a fix with an empty `stream` → check 6 fails.

import Foundation

private var failures = 0
private var checks = 0

private func check(_ condition: Bool, _ label: String) {
    checks += 1
    if !condition {
        failures += 1
        FileHandle.standardError.write("FAIL: \(label)\n".data(using: .utf8)!)
    }
}

private func eq<T: Equatable>(_ got: T?, _ want: T?, _ label: String) {
    checks += 1
    if got != want {
        failures += 1
        FileHandle.standardError.write(
            "FAIL: \(label)\n  got:  \(String(describing: got))\n  want: \(String(describing: want))\n"
                .data(using: .utf8)!)
    }
}

@main
enum FailureSignalsChecks {
    static func main() { runChecks() }
}

// swiftlint:disable:next function_body_length
private func runChecks() {

// ── 1. Capability gap parsing ─────────────────────────────────────────────

let flutterGap: [String: Any] = [
    "code": "capability.toolchain_missing",
    "capability": "flutter",
    "summary": "Flutter is not installed on this machine.",
    "detail": "Yaver can install it here — about 1.2 GB, a few minutes.",
    "fix": [
        "label": "Install Flutter",
        "method": "POST",
        "path": "/install/flutter",
        "stream": "install:flutter",
        "est": "~4 min",
        "retry": true,
    ] as [String: Any],
]

let gap = FailureSignals.parseCapabilityGap(flutterGap)
check(gap != nil, "1: a well-formed gap parses")
eq(gap?.code, FailureSignals.capabilityToolchainMissing, "2: code round-trips")
eq(FailureSignals.gapTitle(gap!), "Flutter is not installed on this machine.", "3: title is the summary")
eq(FailureSignals.gapFixLabel(gap), "Install Flutter · ~4 min", "4: label carries the estimate")
eq(FailureSignals.gapStreamPath(gap), "/streams/install:flutter", "5: stream path is derived, not re-typed")
eq(FailureSignals.gapInstallTool(gap), "flutter", "6: install tool comes from the fix path")
check(FailureSignals.gapRetriesAfterFix(gap), "7: retry flag survives")

// A gap with no code or no summary is not a gap.
check(FailureSignals.parseCapabilityGap(["summary": "no code here"]) == nil, "8: no code → nil")
check(FailureSignals.parseCapabilityGap(["code": "x"]) == nil, "9: no summary → nil")
check(FailureSignals.parseCapabilityGap("a string") == nil, "10: non-object → nil")

// THE DEFECT THIS PREVENTS: a fix with no stream renders a button that starts
// a 1.2 GB download the user can never see. Refuse the button, keep the gap.
let unstreamable = FailureSignals.parseCapabilityGap([
    "code": "capability.toolchain_missing",
    "summary": "Xcode is not installed.",
    "constraint": "Xcode cannot be installed unattended — get it from the App Store.",
    "fix": ["label": "Install", "path": "/install/xcode"] as [String: Any],
])
check(unstreamable != nil, "11a: an unfixable gap still parses")
check(unstreamable?.fix == nil, "11b: a fix with no stream is dropped, not rendered")
eq(FailureSignals.gapFixLabel(unstreamable), nil, "11c: no label ⇒ no button")
eq(FailureSignals.gapBody(unstreamable!),
   "Xcode cannot be installed unattended — get it from the App Store.",
   "11d: with no fix, the body IS the constraint")

// The three channels the agent carries a gap on all reach the same parser.
eq(FailureSignals.capabilityGapFromBody(["capabilityGap": flutterGap])?.capability, "flutter",
   "11e: /dev/start 412 + /tasks 500 body key")
eq(FailureSignals.capabilityGapFromDevEvent(["type": "error", "gap": flutterGap])?.capability, "flutter",
   "11f: /dev/events SSE frame key")
let rawBody = try! JSONSerialization.data(withJSONObject: ["capabilityGap": flutterGap])
eq(FailureSignals.capabilityGapFromData(rawBody)?.capability, "flutter", "11g: straight from response bytes")
check(FailureSignals.capabilityGapFromData("not json".data(using: .utf8)!) == nil, "11h: non-JSON body → nil")
eq(FailureSignals.gapInstallTool(FailureSignals.parseCapabilityGap([
    "code": "c", "summary": "s",
    "fix": ["path": "/dev/start", "stream": "s"] as [String: Any],
])), nil, "11i: a non-install route yields no install tool")

// ── 2. Stream recovery ────────────────────────────────────────────────────

// THE SHIPPED BUG: a stream that closes cleanly with no error object was read
// as "nothing more happened". It is a dropped tunnel.
eq(FailureSignals.classifyStreamEnd(sawDone: false, cancelled: false), .interrupted,
   "12: clean EOF with no done frame is an INTERRUPTION")
eq(FailureSignals.classifyStreamEnd(sawDone: true, cancelled: false), .done, "13: done frame wins")
eq(FailureSignals.classifyStreamEnd(sawDone: false, cancelled: true), .cancelled, "14: local teardown is not a failure")
eq(FailureSignals.classifyStreamEnd(sawDone: true, cancelled: true), .done, "15: done outranks cancel")

eq(FailureSignals.planStreamRecovery(end: .done, attempt: 0), .idle, "16: a finished stream needs no plan")
eq(FailureSignals.planStreamRecovery(end: .cancelled, attempt: 0), .idle, "17: a cancelled stream needs no plan")

if case let .reattach(attempt, delayMs, message) = FailureSignals.planStreamRecovery(end: .interrupted, attempt: 0) {
    eq(attempt, 0, "18: first attempt")
    eq(delayMs, 1000, "19: first rung is fast")
    check(message.contains("reattaching (1 of 5)"), "20: the count is in the sentence")
    check(message.contains("still running on the box"), "21: names the fact the user cannot guess")
} else {
    check(false, "18-21: an interrupted stream must plan a reattach")
}

eq(FailureSignals.reattachDelayMs(0), 1000, "22: ladder rung 0")
eq(FailureSignals.reattachDelayMs(4), 15000, "23: ladder caps at 15s")
eq(FailureSignals.reattachDelayMs(99), 15000, "24: past the end still caps, never crashes")
eq(FailureSignals.reattachDelayMs(-1), 1000, "24b: a negative attempt clamps, never crashes")

if case let .giveUp(message) = FailureSignals.planStreamRecovery(
    end: .interrupted, attempt: 5, cause: "relay tunnel closed"
) {
    check(message.contains("after 5 attempts"), "25a: says how hard it tried")
    check(message.contains("(relay tunnel closed)"), "25b: carries the transport's own words")
    check(message.contains("this is the stream, not the work"), "25c: the load-bearing distinction")
} else {
    check(false, "25: exhausted attempts must give up, not loop")
}

// ── 3. Relay deny ─────────────────────────────────────────────────────────

// device_mismatch: the one relay verdict a retry can NEVER fix. Rendering it
// as generic unreachability is what produced "Reconnecting (n/5)" forever.
let mismatch = FailureSignals.explainRelayDeny("relay refused: reason=device_mismatch")
check(mismatch != nil, "26a: device_mismatch is named")
check(mismatch!.contains("Retrying can't help"), "26b: says a retry is futile")
check(mismatch!.contains("yaver auth"), "26c: names the command that actually fixes it")
check(FailureSignals.explainRelayDeny("user abc does not own this deviceId") != nil,
      "26d: the relay's other spelling of the same verdict")
check(FailureSignals.explainRelayDeny("connection reset by peer") == nil,
      "26e: a retryable transport error is NOT given a terminal sentence")
check(FailureSignals.explainRelayDeny(nil) == nil, "26f: nil cause → nil")

let bw = FailureSignals.classifyRelayLimit("bandwidth limit exceeded: 480MB used of 500MB daily limit")
eq(bw?.kind, "bandwidth-cap", "26g: bandwidth cap classified")
check(bw!.detail.contains("480 MB of its 500 MB"), "26h: the real numbers, not a generic cap")
check(bw!.detail.contains("cut by the cap, not by your network"), "26i: pre-empts the wrong diagnosis")
eq(FailureSignals.classifyRelayLimit("free relay user rate limit exceeded")?.kind, "free-tier-rate", "26j")
eq(FailureSignals.classifyRelayLimit("rate limit exceeded")?.kind, "rate-limit", "26k")
check(FailureSignals.classifyRelayLimit("no route to host") == nil, "26l: a non-limit message is not a limit card")
check(FailureSignals.classifyRelayLimit(nil) == nil, "26m: nil → nil")

// ── 4. Runner auth ────────────────────────────────────────────────────────

// THE SHIPPED BUG: tvOS's terminal set was {cancelled, canceled, error,
// failed}. An account_not_eligible session polled every 2s forever, showing a
// stale "pending" row over a decided verdict.
check(FailureSignals.isRunnerAuthTerminal("account_not_eligible"),
      "27: account_not_eligible is TERMINAL")
check(FailureSignals.isRunnerAuthTerminal("completed"), "28a")
check(FailureSignals.isRunnerAuthTerminal("failed"), "28b")
check(FailureSignals.isRunnerAuthTerminal("cancelled"), "28c")
check(FailureSignals.isRunnerAuthTerminal("canceled"), "28d: the American spelling the agent also emits")
check(!FailureSignals.isRunnerAuthTerminal("awaiting_browser"), "28e: still running")
check(!FailureSignals.isRunnerAuthTerminal("verifying"), "28f: still running")
check(!FailureSignals.isRunnerAuthTerminal(nil), "28g: unknown is not terminal")

let ineligible = FailureSignals.explainRunnerAuthOutcome(
    status: "account_not_eligible", runnerLabel: "Claude Code", error: nil,
    detail: "Login failed: no active subscription"
)
check(ineligible != nil, "29a: the verdict is explained")
check(ineligible!.contains("The sign-in itself worked"), "29b: does not blame the user's password")
check(ineligible!.contains("cannot succeed"), "29c: says a retry is futile")
check(ineligible!.contains("Login failed: no active subscription"), "29d: keeps the CLI's own words")
check(FailureSignals.runnerAuthRetryIsFutile("account_not_eligible"), "29e: no Try again button here")
check(!FailureSignals.runnerAuthRetryIsFutile("failed"), "29f: a plain failure IS worth retrying")

eq(FailureSignals.explainRunnerAuthOutcome(status: "completed", runnerLabel: "Codex", error: nil, detail: nil),
   nil, "30a: success has no error sentence")
eq(FailureSignals.explainRunnerAuthOutcome(status: "awaiting_browser", runnerLabel: "Codex", error: nil, detail: nil),
   nil, "30b: a running session has no outcome yet")
eq(FailureSignals.explainRunnerAuthOutcome(status: "failed", runnerLabel: "Codex", error: nil, detail: nil),
   "Codex auth ended with failed.", "30c: falls back to a named runner + status")
eq(FailureSignals.explainRunnerAuthOutcome(status: "failed", runnerLabel: "Codex", error: "exit status 1", detail: nil),
   "exit status 1", "30d: prefers the real error when there is one")

// Liveness: every wait must narrate itself.
let t0: Double = 1_700_000_000_000
eq(FailureSignals.runnerAuthLivenessLine(now: t0, startedAt: nil, lastOutputAt: nil), nil,
   "31a: no start time ⇒ nothing truthful to say")
eq(FailureSignals.runnerAuthLivenessLine(now: t0 + 42_000, startedAt: t0, lastOutputAt: nil),
   "Started 42s ago · the CLI has printed nothing yet", "31b: silence is stated, not hidden")
eq(FailureSignals.runnerAuthLivenessLine(now: t0 + 134_000, startedAt: t0, lastOutputAt: t0 + 131_000),
   "Started 2m 14s ago · CLI last output 3s ago", "31c: elapsed AND last progress")
eq(FailureSignals.runnerAuthLivenessLine(now: t0, startedAt: t0, lastOutputAt: t0 - 5_000),
   "Started 0s ago · the CLI has printed nothing yet", "31d: a stale stamp is ignored, not shown")
eq(FailureSignals.shortDuration(59_400), "59s", "31e")
eq(FailureSignals.shortDuration(60_000), "1m 0s", "31f")

// ── report ────────────────────────────────────────────────────────────────

if failures == 0 {
    print("ok — \(checks) checks passed (tvos/YaverTV/FailureSignals.swift)")
    exit(0)
} else {
    FileHandle.standardError.write("\n\(failures) of \(checks) checks FAILED\n".data(using: .utf8)!)
    exit(1)
}

}
