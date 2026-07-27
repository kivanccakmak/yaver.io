import Foundation

// ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
//
// Swift port of sdk/feedback/{web,react-native}/src/reloadActions.ts,
// sdk/feedback/flutter/lib/src/reload_actions.dart and
// sdk/feedback/unity/Runtime/YaverReloadActions.cs. Same three questions,
// same answers, same wording — because a bug fixed in one SDK must not still
// be shipping in the other five:
//
//   1. WHICH actions may be shown at all (release build ⇒ none, ever)?
//   2. WHICH request does each action make (path + body)?
//   3. WHEN a reload fails, WHAT do we tell the user?
//
// Deliberately PURE — no URLSession, no UIKit, no globals. That is what makes
// it testable without a device, and the test is the guard.
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
//        Hermes bytecode rebuild — React Native ONLY. A native Swift app can
//        never load one, so this SDK does not offer it. Offering an action
//        that cannot work teaches the user the product lies.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// No new secret. /dev/reload is registered under `authSDKOrGuest` in
// desktop/agent/httpserver.go — the same middleware that already admits the
// bearer this SDK sends with its feedback POST — and the scope-limited
// `guest-reload` SDK token already lists the route.

/// Stable identifier for each action the UI can render.
public enum ReloadActionID: String, Equatable, Sendable {
    case hot
    case full
}

/// Wire value of the `mode` field on POST /dev/reload.
public enum ReloadWireMode: String, Equatable, Sendable {
    case fast
    case full
}

/// Framework families whose reload vocabulary we borrow.
public enum ReloadFrameworkFamily: Equatable, Sendable {
    case flutter
    case reactNative
    case web
    case unknown
}

/// The part of `GET /dev/status` this decision depends on.
public struct DevServerSnapshot: Equatable, Sendable {
    /// Is a dev server process alive on the machine?
    public let running: Bool
    /// Is it still compiling? A reload now would race the build.
    public let building: Bool
    /// Agent framework name: expo | react-native | flutter | vite | nextjs.
    public let framework: String?

    public init(running: Bool, building: Bool = false, framework: String? = nil) {
        self.running = running
        self.building = building
        self.framework = framework
    }

    /// Parse a `/dev/status` body.
    ///
    /// Anything missing or malformed degrades to "not running" rather than to
    /// an optimistic default — claiming a dev server we have not seen is how
    /// a button ends up doing nothing in silence.
    public init(json: [String: Any]) {
        self.running = (json["running"] as? Bool) == true
        self.building = (json["building"] as? Bool) == true
        self.framework = json["framework"] as? String
    }
}

/// One button the UI may render.
public struct ReloadAction: Equatable, Sendable {
    public let id: ReloadActionID
    /// Button title — stack-idiomatic wording lives here, not at the call site.
    public let label: String
    /// One line explaining what the action actually does.
    public let hint: String
    public let mode: ReloadWireMode
    /// Agent path this action POSTs to.
    public let path: String
    public let enabled: Bool
    /// Set exactly when `enabled` is false. Names the specific blocker and the
    /// fix — never "unavailable".
    public let disabledReason: String?

    /// The exact request body this action sends.
    public var body: [String: String] { ["mode": mode.rawValue] }
}

public enum ReloadActions {
    public static let reloadPath = "/dev/reload"
    public static let reloadAppPath = "/dev/reload-app"
    public static let statusPath = "/dev/status"

    /// Map the agent's framework name onto a family.
    ///
    /// An unrecognised framework still gets generic actions: the agent is the
    /// authority on what it can do, and refusing to offer a reload because we
    /// did not recognise a name would be us inventing a limit the product
    /// does not have.
    public static func frameworkFamily(_ framework: String?) -> ReloadFrameworkFamily {
        let f = (framework ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if f.isEmpty { return .unknown }
        if f.contains("flutter") { return .flutter }
        if f == "expo" || f.contains("react-native") || f.contains("metro") { return .reactNative }
        if f == "vite" || f == "next" || f == "nextjs" || f == "web" || f == "webpack" { return .web }
        return .unknown
    }

    private static func labels(
        for family: ReloadFrameworkFamily
    ) -> (hot: (String, String), full: (String, String)) {
        switch family {
        case .flutter:
            return (
                ("Hot Reload", "Flutter hot reload (r) — keeps the current app state."),
                ("Hot Restart", "Flutter hot restart (R) — restarts the app and resets state.")
            )
        case .reactNative:
            return (
                ("Hot Reload", "Fast Refresh through Metro — keeps component state."),
                ("Full Reload", "Reloads the whole JS bundle and resets state.")
            )
        case .web:
            return (
                ("Hot Reload", "Hot module replacement through the dev server."),
                ("Full Reload", "Re-exports the bundle and reloads the page.")
            )
        case .unknown:
            return (
                ("Hot Reload", "The dev server's cheapest refresh."),
                ("Full Reload", "Framework-level restart of the running app.")
            )
        }
    }

    /// The whole decision, in one pure function.
    ///
    /// Returns the ordered list the UI should render. An EMPTY list means
    /// "render no reload UI at all" — that is the release-build answer, and
    /// it is deliberately indistinguishable from "this SDK has no reload
    /// feature", because to a shipped app it doesn't.
    ///
    /// A NON-empty list may still contain disabled entries: showing a greyed
    /// "Hot Reload — no dev server is running on primary" teaches the user
    /// what to fix. Hiding it teaches them nothing.
    ///
    /// - Parameter isDevBuild: Swift's signal is a `#if DEBUG` compile flag,
    ///   resolved by the caller (`FeedbackConfig.devBuild`). There is no
    ///   default here on purpose: false means the list is EMPTY, and a
    ///   shipped app never gets a reload button.
    public static func build(
        snapshot: DevServerSnapshot?,
        isDevBuild: Bool,
        connected: Bool,
        machineLabel: String? = nil
    ) -> [ReloadAction] {
        // 1. Release build — never, under any circumstance.
        guard isDevBuild else { return [] }

        let snap = snapshot ?? DevServerSnapshot(running: false)
        let l = labels(for: frameworkFamily(snap.framework))
        let trimmed = (machineLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let machine = trimmed.isEmpty ? "the selected machine" : trimmed

        var blocked: String?
        if !connected {
            blocked = "Not connected to a machine yet — pick one first."
        } else if snap.building {
            blocked = "The dev server is still building — reload works once it finishes."
        } else if !snap.running {
            blocked = "No dev server is running on \(machine). "
                + "Start one from the Yaver app, or run `yaver dev start` there."
        }

        return [
            ReloadAction(
                id: .hot, label: l.hot.0, hint: l.hot.1, mode: .fast,
                path: reloadPath, enabled: blocked == nil, disabledReason: blocked
            ),
            ReloadAction(
                id: .full, label: l.full.0, hint: l.full.1, mode: .full,
                path: reloadPath, enabled: blocked == nil, disabledReason: blocked
            ),
        ]
    }

    /// Turn a failed reload into a sentence that names the cause AND the fix.
    ///
    /// "Reload failed" is the shape of error this codebase keeps paying whole
    /// sessions for. Every branch below exists because the raw text the agent
    /// (or Go's net stack) produces is accurate and unreadable.
    ///
    /// - Parameter status: 0 means the request never reached anything — a
    ///   different problem from a 5xx, needing a different sentence.
    public static func describeFailure(
        status: Int,
        body: String,
        snapshot: DevServerSnapshot? = nil
    ) -> String {
        let lower = body.lowercased()
        let framework = (snapshot?.framework ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if lower.contains("does not support hot reload") {
            let name = framework.isEmpty ? "This dev server" : framework
            return "\(name) cannot hot reload. Restart the dev server on the machine."
        }
        if status == 503 || lower.contains("no dev server") || lower.contains("dev server not available") {
            return "No dev server is running on the machine. Start one before reloading."
        }
        if (lower.contains("connection refused") || lower.contains("econnrefused"))
            && (lower.contains("127.0.0.1") || lower.contains("localhost")) {
            return "The dev server is not listening on the machine. Start it with `yaver dev start`."
        }
        if status == 401 || status == 403 {
            return "The machine rejected this session — sign in again, or re-pair this device."
        }
        if status == 404 {
            return "This machine's agent has no /dev/reload route — it is too old. "
                + "Update it with `npm install -g yaver-cli@latest`."
        }
        if status >= 500 {
            return "The agent hit an internal error while reloading. Check `yaver logs` on the machine."
        }
        if status == 0 {
            return "Could not reach the machine. Check that it is online and `yaver serve` is running."
        }
        return "Reload failed (HTTP \(status))."
    }
}
