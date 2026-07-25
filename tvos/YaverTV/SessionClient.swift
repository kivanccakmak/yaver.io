// SessionClient.swift — drives a LIVE coding session via POST /runner/session/turn.
//
// This is the endpoint a TV should call (docs/yaver-tvos-surface.md §2.2 / §4).
// Unlike /watch/turn (which spawns a new task), this drives the session the user
// already has running — "keep developing this" means the ubuntu session, not a
// fresh task.
//
// The TV can render more than a watch: it shows the pane as monospaced text,
// renders options as focusable D-pad buttons, and speaks a summary via
// AVSpeechSynthesizer. So this client returns the FULL session response (pane +
// options + awaitingChoice) rather than collapsing it to one line.
//
// The four server-side guards (docs/yaver-tvos-surface.md §2.2) are honored by
// the endpoint — 409s carry the same body as 200 (awaitingChoice + options +
// pane), so we decode them the same way.

import Foundation

struct SessionTurnResult: Codable {
    let ok: Bool?
    let session: String?
    let runner: String?
    let sent: String?           // "prompt" or "choice"
    let awaitingChoice: Bool?
    let options: [String]?
    let pane: String?
    let error: String?
}

private struct RuntimeTurnOpsEnvelope: Decodable {
    let ok: Bool?
    let initial: RuntimeTurnResult?
    let error: String?
}

private struct RuntimeTurnResult: Decodable {
    let ok: Bool?
    let state: String?
    let spoken: String?
    let awaitingChoice: Bool?
    let options: [String]?
    let panel: RuntimeTurnPanel?
    let queue: RuntimeTurnQueueItem?
    let error: String?
}

private struct RuntimeTurnPanel: Decodable {
    let kind: String?
    let text: String?
}

private struct RuntimeTurnQueueItem: Decodable {
    let session: String?
    let runner: String?
}

/// One row of the runtime-turn queue, for the TV's list view.
///
/// A TV is usually in a shared room, so this carries only what is safe to put
/// on a large screen someone else may be looking at: the utterance the user
/// spoke, its state, and where it came from. No pane text, no diffs, no paths.
struct RuntimeTurnRow: Decodable, Identifiable {
    let itemId: String
    let state: String
    let utterance: String
    let intentClass: String?
    let spoken: String?
    let taskId: String?
    let testTarget: RuntimeTurnTestTargetInfo?

    var id: String { itemId }

    /// Runtime turns begin as raw speech/text and may mention a local path.
    /// The TV is a shared-room surface, so redact before showing it.
    var safeUtterance: String { redactHomePaths(utterance) }

    /// Whether the user can actually test this yet — see
    /// desktop/agent/runtime_queue.go. `delivered` means a device ACCEPTED the
    /// reload; only `verified` means it really loaded.
    var testSummary: String? {
        guard state == "ready_to_test" || state == "ready_to_deploy" else { return nil }
        switch testTarget?.state {
        case .some("verified"): return "Running on your device"
        case .some("delivered"): return "Sent — waiting for it to load"
        case .some("unreachable"): return "Nothing was listening"
        case .some("failed"): return "Reload failed on the device"
        default: return "Not on a device yet"
        }
    }
}

struct RuntimeTurnTestTargetInfo: Decodable {
    let state: String?
    let detail: String?
    let listeners: Int?
}

private struct RuntimeTurnListEnvelope: Decodable {
    let ok: Bool?
    let initial: RuntimeTurnList?
    let error: String?
}

private struct RuntimeTurnList: Decodable {
    let ok: Bool?
    let items: [RuntimeTurnRow]?
    let count: Int?
}

actor SessionClient {
    private let token: String
    private let box: BoxTarget
    private let session: URLSession

    private struct Endpoint {
        let url: URL
        let relay: Bool
    }

    init(token: String, box: BoxTarget) {
        self.token = token
        self.box = box
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: cfg)
    }

    /// Send a prompt to a named session.
    ///
    /// `session` is not optional-by-accident: omitting it makes the agent guess,
    /// and `resolveRunnerSession` (`runner_session_turn.go:81`) only guesses when
    /// EXACTLY one runner PTY is live. On a box with none it errors; on a box with
    /// two it errors with "several runner sessions are live — name the one you
    /// mean" — and a caller that cannot name one is simply stuck. Worse, when the
    /// single live session happened to be the user's own hand-rolled tmux window,
    /// the guess drove THAT: a prompt typed into a personal Claude Code session,
    /// its private scrollback rendered back onto a television. Name the session.
    func sendText(_ text: String, session: String?, waitMs: Int = 6000) async throws -> SessionTurnResult {
        try await turn(text: text, choice: nil, session: session, waitMs: waitMs)
    }

    /// Answer a menu the pane is showing.
    func sendChoice(_ choice: String, session: String?, waitMs: Int = 6000) async throws -> SessionTurnResult {
        try await turn(text: nil, choice: choice, session: session, waitMs: waitMs)
    }

    private func turn(text: String?, choice: String?, session: String?, waitMs: Int) async throws -> SessionTurnResult {
        do {
            return try await runtimeTurn(text: text, choice: choice, session: session, waitMs: waitMs)
        } catch {
            // Older agents do not have runtime_turn yet. The direct endpoint is
            // still the proven TV path, so keep it as a rollout fallback.
        }
        return try await directTurn(text: text, choice: choice, session: session, waitMs: waitMs)
    }

    /// List recent runtime turns for a TV dashboard.
    ///
    /// Returns [] rather than throwing when the agent is too old to know the
    /// verb: a missing list is an empty dashboard, not an error banner on
    /// someone's television.
    func runtimeTurns(limit: Int = 25) async -> [RuntimeTurnRow] {
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "verb": "runtime_turns",
            "payload": ["limit": limit],
            "machine": "local",
        ]) else { return [] }

        guard let data = (try? await request("POST", path: "/ops", body: body, failure: "runtime turns failed"))?.data else { return [] }
        if let env = try? JSONDecoder().decode(RuntimeTurnListEnvelope.self, from: data),
           let items = env.initial?.items {
            return items
        }
        // Some ops transports return the payload unwrapped.
        if let list = try? JSONDecoder().decode(RuntimeTurnList.self, from: data),
           let items = list.items {
            return items
        }
        return []
    }

    private func runtimeTurn(text: String?, choice: String?, session: String?, waitMs: Int) async throws -> SessionTurnResult {
        var target: [String: Any] = [:]
        if let session, !session.isEmpty { target["session"] = session }
        var payload: [String: Any] = [
            "utterance": text ?? "",
            "target": target,
            "surface": [
                "id": "tvos",
                "class": "tv-apple",
                "interaction": "dpad",
                "visualBudget": "panel",
                "riskPolicy": "shared-tv",
                "ttsBudget": 240,
                "replyTo": "tvos",
            ],
            "development": [
                "intentClass": choice == nil ? "session-turn" : "session-turn",
                "queue": [
                    "mode": "run",
                    "priority": "normal",
                    "afterFinish": ["load-mobile-container", "ask-deploy"],
                ],
                "meta": ["source": "tvos-session"],
            ],
            "mode": "run",
        ]
        if let choice, !choice.isEmpty { payload["choice"] = choice }
        let body = try JSONSerialization.data(withJSONObject: [
            "verb": "runtime_turn",
            "payload": payload,
            "machine": "local",
        ])

        let data = try await request("POST", path: "/ops", body: body, failure: "runtime turn failed").data
        let envelope = try JSONDecoder().decode(RuntimeTurnOpsEnvelope.self, from: data)
        if envelope.ok == false {
            throw AgentError(message: envelope.error ?? "runtime turn failed")
        }
        guard let result = envelope.initial else {
            throw AgentError(message: "runtime turn returned no result")
        }
        if result.ok == false, let err = result.error {
            throw AgentError(message: err)
        }
        return SessionTurnResult(
            ok: result.ok,
            session: result.queue?.session,
            runner: result.queue?.runner,
            sent: choice == nil ? "prompt" : "choice",
            awaitingChoice: result.awaitingChoice,
            options: result.options,
            pane: result.panel?.text ?? result.spoken,
            error: result.error
        )
    }

    private func directTurn(text: String?, choice: String?, session: String?, waitMs: Int) async throws -> SessionTurnResult {
        var body: [String: Any] = ["waitMs": waitMs]
        if let text { body["text"] = text }
        if let choice { body["choice"] = choice }
        if let session, !session.isEmpty { body["session"] = session }

        // 409 is the guards firing — decode the same as 200.
        let response = try await request("POST", path: "/runner/session/turn",
                                         body: try JSONSerialization.data(withJSONObject: body),
                                         failure: "session turn failed",
                                         extraOK: [409])
        return try JSONDecoder().decode(SessionTurnResult.self, from: response.data)
    }

    private func request(_ method: String, path: String, body: Data?, failure: String, extraOK: Set<Int> = []) async throws -> (data: Data, status: Int) {
        let endpoints = requestEndpoints(path: path)
        guard !endpoints.isEmpty else { throw AgentError(message: "bad box host") }

        var lastError: Error = AgentError(message: failure)
        for endpoint in endpoints {
            var req = URLRequest(url: endpoint.url)
            req.httpMethod = method
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(Backend.surface, forHTTPHeaderField: "X-Yaver-Surface")
            if endpoint.relay, let pw = box.relayPassword, !pw.isEmpty {
                req.setValue(pw, forHTTPHeaderField: "X-Relay-Password")
            }
            req.httpBody = body

            do {
                let (data, resp) = try await self.session.data(for: req)
                guard let http = resp as? HTTPURLResponse else {
                    throw AgentError(message: "no response")
                }
                if (200..<300).contains(http.statusCode) || extraOK.contains(http.statusCode) {
                    return (data, http.statusCode)
                }
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let err = obj["error"] as? String, !err.isEmpty {
                    throw AgentError(message: err)
                }
                lastError = AgentError(message: "\(failure) (\(http.statusCode))")
                continue
            } catch let err as AgentError {
                throw err
            } catch {
                lastError = error
                continue
            }
        }
        throw lastError
    }

    private func requestEndpoints(path rawPath: String) -> [Endpoint] {
        box.requestEndpoints(path: rawPath).map { Endpoint(url: $0.url, relay: $0.relay) }
    }
}
