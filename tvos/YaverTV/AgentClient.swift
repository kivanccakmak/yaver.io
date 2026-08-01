// AgentClient.swift — calls a Yaver agent's /ops endpoint over LAN HTTP.
//
// Mirrors mobile/src/lib/appletvClient.ts::atvOps: POST http://<host>:<port>/ops
// with body { verb, payload, machine:"local" } + Authorization: Bearer <token>.
// The agent returns either the result object directly or { initial: <result> }
// for streaming verbs; we unwrap `initial` like the RN client does.

import Foundation

struct AgentError: AgentErrorCoded, LocalizedError {
    let message: String
    /// The structured capability gap the agent attached to this refusal, when
    /// it attached one. `message` stays exactly what it always was — a shipped
    /// view that renders only the message must not lose a word — and `gap` is
    /// the additive route a view can turn into a button.
    ///
    /// Without this, every 412 from /dev/start arrived as the flat sentence
    /// "flutter is not installed", the `fix` object was discarded by the
    /// transport, and the TV showed a spinner over a fact the agent had
    /// already stated. Same shape as the 2026-07-26 phone incident.
    var gap: CapabilityGap? = nil
    /// Stable reason code from the agent's error body (`code` key —
    /// reason_codes.go vocabulary, e.g. auth.session.scope_denied). Lets views
    /// classify a refusal without regexing prose. nil on old agents.
    var code: String? = nil
    var errorDescription: String? { message }
}

actor AgentClient {
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

    /// Low-level call: returns the decoded result for `verb`.
    func ops<T: Decodable>(_ verb: String, _ payload: [String: Any] = [:], as type: T.Type) async throws -> T {
        let data = try await rawOps(verb, payload)
        // Unwrap { initial: ... } if present (streaming verbs), else decode whole.
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let ok = obj["ok"] as? Bool, !ok {
                throw AgentError(message: obj["error"] as? String ?? "\(verb) failed")
            }
            if let initial = obj["initial"] {
                let inner = try JSONSerialization.data(withJSONObject: initial)
                return try JSONDecoder().decode(T.self, from: inner)
            }
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Fire-and-check verbs that only report ok/error.
    ///
    /// A refused verb comes back as HTTP 200 with `{"ok":false,"error":"…"}` —
    /// not a 4xx — so rawOps lets it through. Returning that `false` to a caller
    /// that writes `_ = try await client.call("reload")` threw the reason away
    /// and left the button looking dead: the agent said "no dev server is
    /// currently running", and the headset said nothing at all. `ok == false` is
    /// a failure; raise it so the surface can show why.
    @discardableResult
    func call(_ verb: String, _ payload: [String: Any] = [:]) async throws -> Bool {
        let data = try await rawOps(verb, payload)
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let ok = obj["ok"] as? Bool, !ok {
                throw AgentError(message: obj["error"] as? String ?? "\(verb) failed")
            }
            if let err = obj["error"] as? String { throw AgentError(message: err) }
            if let ok = obj["ok"] as? Bool { return ok }
        }
        return true
    }

    /// Run an ops verb, trying LAN first and the relay second.
    ///
    /// `machine` selects the TARGET of the verb once a reachable agent is
    /// found: "local" drives the box we connected to, any other device id or
    /// alias is proxied onward by the agent's dispatchOps. That is what lets an
    /// Apple TV drive a Windows tower through whichever box it can actually
    /// reach.
    private func rawOps(_ verb: String, _ payload: [String: Any], machine: String = "local") async throws -> Data {
        let endpoints = box.opsEndpoints
        guard !endpoints.isEmpty else { throw AgentError(message: "bad box host") }

        let body = try JSONSerialization.data(withJSONObject: [
            "verb": verb,
            "payload": payload,
            "machine": machine,
        ])

        var lastError: Error = AgentError(message: "ops \(verb) failed")
        for (index, url) in endpoints.enumerated() {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(Backend.surface, forHTTPHeaderField: "X-Yaver-Surface")
            if let pw = box.relayPassword, !pw.isEmpty, index > 0 {
                req.setValue(pw, forHTTPHeaderField: "X-Relay-Password")
            }
            req.httpBody = body

            do {
                let (data, resp) = try await session.data(for: req)
                guard let http = resp as? HTTPURLResponse else {
                    throw AgentError(message: "no response")
                }
                // The agent returns 200 for results and also 4xx with an
                // {error} body; surface the error message when present, like
                // the RN client.
                if !(200..<300).contains(http.statusCode) {
                    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let err = obj["error"] as? String {
                        // A real answer from a reachable agent — do NOT retry
                        // the next endpoint. Retrying would re-run a verb that
                        // already executed and merely reported a refusal.
                        throw AgentError(message: err)
                    }
                    lastError = AgentError(message: "ops \(verb) failed (\(http.statusCode))")
                    continue // transport-level failure: try the relay
                }
                return data
            } catch let err as AgentError {
                throw err
            } catch {
                // Connection refused / timeout / DNS — this leg is dead, try
                // the next one.
                lastError = error
                continue
            }
        }
        throw lastError
    }

    /// Speak-to-control a desktop from the TV. Reads the target machine's
    /// accessibility tree and returns ONE spoken sentence — no video stream, so
    /// it works on a lean-back surface and costs effectively no relay egress.
    func desktopVoice(_ transcript: String, machine: String = "local") async throws -> String {
        let data = try await rawOps("desktop_voice", ["transcript": transcript], machine: machine)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let initial = obj["initial"] as? [String: Any],
              let spoken = initial["spoken"] as? String,
              !spoken.isEmpty
        else { return "Done." }
        return spoken
    }

    // ---- Typed convenience wrappers for the lean-back surfaces -------------

    func nowPlaying(device: String? = nil) async throws -> NowPlaying {
        try await ops("appletv_now_playing", device.map { ["device": $0] } ?? [:], as: NowPlaying.self)
    }

    func sendKey(_ key: RemoteKey, device: String? = nil) async throws {
        var p: [String: Any] = ["key": key.rawValue]
        if let d = device { p["device"] = d }
        try await call("appletv_remote_key", p)
    }

    func transport(_ action: RemoteKey, device: String? = nil) async throws {
        var p: [String: Any] = ["action": action.rawValue]
        if let d = device { p["device"] = d }
        try await call("appletv_transport", p)
    }

    func launchApp(_ bundleId: String, device: String? = nil) async throws {
        var p: [String: Any] = ["bundle_id": bundleId]
        if let d = device { p["device"] = d }
        try await call("appletv_launch_app", p)
    }

    func captureStatus() async throws -> CaptureStatus {
        try await ops("capture_status", [:], as: CaptureStatus.self)
    }

    func info() async throws -> AgentInfo {
        try await ops("info", [:], as: AgentInfo.self)
    }

    func status() async throws -> AgentStatus {
        try await ops("status", [:], as: AgentStatus.self)
    }

    func voiceStatus() async throws -> VoiceRuntimeStatus {
        try await ops("voice", ["op": "status"], as: VoiceRuntimeStatus.self)
    }

    /// The live runner PTYs on the box — the same set `/runner/session/turn`
    /// drives, so a picker built from this can always name a session the turn
    /// endpoint will accept. NOT `runner`/`agents_list`: that lists agent-graph
    /// tasks and answers 0 on a box with a runner running.
    func runnerSessions() async throws -> RunnerSessions {
        try await ops("runner_sessions", [:], as: RunnerSessions.self)
    }

    func platformMatrix() async throws -> PlatformMatrixEnvelope {
        try await ops("mobile_platform_matrix", [:], as: PlatformMatrixEnvelope.self)
    }

    /// The task queue on the box (GET /tasks). REST, not an ops verb — a glance
    /// list for the TV; the full task lifecycle stays on phone/web.
    func listTasks() async throws -> [TaskSummary] {
        let data = try await request("GET", path: "/tasks", failure: "couldn't load tasks")
        return (try JSONDecoder().decode(TaskList.self, from: data)).tasks
    }

    /// Projects the box knows about (GET /projects → {projects:[…]} or a bare
    /// array). For the TV to browse and pick one to preview.
    func listProjects() async throws -> [ProjectSummary] {
        let data = try await request("GET", path: "/projects", failure: "couldn't load projects")
        if let wrapped = try? JSONDecoder().decode(ProjectList.self, from: data) { return wrapped.projects }
        return (try? JSONDecoder().decode([ProjectSummary].self, from: data)) ?? []
    }

    // ---- Web preview streaming (headless capture → frames) ----------------
    //
    // tvOS has no WebKit, so a web project can't be rendered in-process — it's
    // captured headless on the box at a chosen viewport and streamed as frames.
    // Flow: /dev/web-preview/start (boot a static server) → /vibing/preview/start
    // (headless Chrome captures it) → poll /vibing/preview/snapshot for the newest
    // frame hash → GET /vibing/preview/frames/{hash} for the bytes.

    struct WebPreviewStart: Decodable { let ok: Bool?; let port: Int?; let webUrl: String? }
    struct DevServerEvent: Decodable {
        let type: String?
        let framework: String?
        let logLine: String?
        let message: String?
        let timestamp: String?
        let bundleUrl: String?
        let deepLink: String?
    }
    struct DevStartResult: Decodable {
        let ok: Bool?
        let mode: String?
        let running: Bool?
        let framework: String?
        let url: String?
        let port: Int?
    }

    /// Start the selected project's web lane. `/dev/web-preview/start` only
    /// starts an Expo web sibling for the active dev server; this is the call
    /// that makes the selected project become active in the first place.
    func startDevServer(for project: ProjectSummary) async throws -> DevStartResult {
        var body: [String: Any] = [
            "surface": "web-reload",
            "caller": "web-ui",
            "platform": "web",
            "projectName": project.name,
        ]
        if let workDir = project.path, !workDir.isEmpty { body["workDir"] = workDir }
        if let framework = project.framework, !framework.isEmpty { body["framework"] = framework }
        let data = try await postJSON("/dev/start", body)
        return (try? JSONDecoder().decode(DevStartResult.self, from: data)) ?? DevStartResult(ok: true, mode: nil, running: nil, framework: project.framework, url: nil, port: nil)
    }

    /// Start capturing a project's web preview at the given viewport. Returns
    /// when the vibe session is up (first frame may lag a beat).
    func startWebPreview(project: String, targetUrl: String, width: Int, height: Int) async throws {
        _ = try await postJSON("/vibing/preview/start", [
            "project": project, "targetUrl": targetUrl,
            "mode": "live", "width": width, "height": height,
        ])
    }

    /// Boot the box's static web-preview server; returns its URL to capture.
    func startWebServer() async throws -> WebPreviewStart {
        let data = try await postJSON("/dev/web-preview/start", [:])
        return (try? JSONDecoder().decode(WebPreviewStart.self, from: data)) ?? WebPreviewStart(ok: true, port: nil, webUrl: nil)
    }

    struct SnapshotMeta: Decodable { let hash: String?; let seq: Int?; let size: Int? }

    /// The newest captured frame's hash (POST /vibing/preview/snapshot).
    func previewSnapshot(project: String) async throws -> SnapshotMeta {
        let data = try await postJSON("/vibing/preview/snapshot", ["project": project])
        return try JSONDecoder().decode(SnapshotMeta.self, from: data)
    }

    /// Fetch a captured frame's bytes by hash.
    func previewFrame(hash: String) async throws -> Data {
        try await request("GET", path: "/vibing/preview/frames/\(hash)", failure: "frame unavailable")
    }

    func stopWebPreview(project: String) async {
        _ = try? await postJSON("/vibing/preview/stop", ["project": project])
    }

    /// Subscribe to `/dev/events` and parse the same SSE stream the phone and
    /// web dashboard use for Metro/Expo/Flutter progress.
    ///
    /// This is intentionally LAN/relay HTTP, not Convex: startup logs can be
    /// chatty, and sending every bundler line through the multi-tenant backend
    /// would turn a local preview problem into a billable cloud log stream.
    /// The agent already retains a bounded replay window, so late subscribers
    /// still get the recent tail without another storage surface.
    ///
    /// `onGap` fires when a frame carries a structured capability gap, and
    /// `onEnd` fires EXACTLY ONCE when the stream stops for any reason.
    ///
    /// THE BUG onEnd EXISTS TO KILL: this function used to `return` silently
    /// when the SSE body ended. `/dev/events` is a bus that should never close,
    /// so a clean EOF is what a dropped relay tunnel looks like — and the log
    /// panel simply stopped growing, with the box still compiling happily. A
    /// stream that ends without saying so is the same defect as a silent
    /// `serve`. The caller classifies with FailureSignals.classifyStreamEnd and
    /// decides whether to reattach; this function only reports the truth.
    func subscribeDevEvents(
        onEvent: @escaping @Sendable (DevServerEvent) -> Void,
        onGap: (@Sendable (CapabilityGap) -> Void)? = nil,
        onEnd: (@Sendable (FailureSignals.StreamEndKind, String?) -> Void)? = nil,
        onError: (@Sendable (String) -> Void)? = nil
    ) -> Task<Void, Never> {
        let endpoints = requestEndpoints(path: "/dev/events")
        let token = self.token
        let relayPassword = box.relayPassword
        let urlSession = self.session
        return Task {
            var lastError = "dev event stream unavailable"
            var connected = false
            for endpoint in endpoints {
                if Task.isCancelled { onEnd?(.cancelled, nil); return }
                var req = URLRequest(url: endpoint.url)
                req.httpMethod = "GET"
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue(Backend.surface, forHTTPHeaderField: "X-Yaver-Surface")
                if endpoint.relay, let relayPassword, !relayPassword.isEmpty {
                    req.setValue(relayPassword, forHTTPHeaderField: "X-Relay-Password")
                }
                do {
                    let (bytes, resp) = try await urlSession.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        lastError = "dev event stream returned HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)"
                        continue
                    }
                    connected = true
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled { onEnd?(.cancelled, nil); return }
                        if line.isEmpty {
                            emitDevEvent(dataLines, onEvent: onEvent, onGap: onGap)
                            dataLines.removeAll(keepingCapacity: true)
                            continue
                        }
                        if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    emitDevEvent(dataLines, onEvent: onEvent, onGap: onGap)
                    // The body ended and nobody asked it to. /dev/events has no
                    // terminal frame, so there is no such thing as a stream that
                    // finished on purpose — this is an interruption, and saying
                    // "done" here is exactly how the frozen panel shipped.
                    onEnd?(.interrupted, "the box closed the event stream")
                    return
                } catch {
                    if Task.isCancelled { onEnd?(.cancelled, nil); return }
                    lastError = error.localizedDescription
                    // A mid-stream throw AFTER a successful connect is a drop,
                    // not "this endpoint is dead, try the next one" — walking on
                    // to the relay would restart from zero and lose the tail.
                    if connected {
                        onEnd?(.interrupted, lastError)
                        return
                    }
                    continue
                }
            }
            onError?(lastError)
            onEnd?(.interrupted, lastError)
        }
    }

    private nonisolated func emitDevEvent(
        _ dataLines: [String],
        onEvent: @escaping @Sendable (DevServerEvent) -> Void,
        onGap: (@Sendable (CapabilityGap) -> Void)? = nil
    ) {
        guard !dataLines.isEmpty else { return }
        let payload = dataLines.joined(separator: "\n")
        guard let data = payload.data(using: .utf8) else { return }
        // The gap rides the SAME frame as the log line (`{type:"error",
        // gap:{…}}`), and DevServerEvent is a fixed Decodable that cannot see
        // it. Parse the raw object alongside rather than widening the struct.
        if let onGap,
           let obj = try? JSONSerialization.jsonObject(with: data),
           let gap = FailureSignals.capabilityGapFromDevEvent(obj) {
            onGap(gap)
        }
        guard let event = try? JSONDecoder().decode(DevServerEvent.self, from: data) else { return }
        onEvent(event)
    }

    // ---- Capability-gap fix: run the route the gap carries ----------------

    struct InstallStarted: Decodable { let ok: Bool?; let tool: String?; let stream: String? }

    /// POST /install/<tool>. The agent answers 202 with the log-stream name to
    /// watch; prefer ITS name over our copy so a server-side rename cannot
    /// leave the TV subscribed to nothing.
    func installTool(_ tool: String) async throws -> InstallStarted {
        let data = try await postJSON("/install/\(tool)", [:])
        return (try? JSONDecoder().decode(InstallStarted.self, from: data))
            ?? InstallStarted(ok: true, tool: tool, stream: "install:\(tool)")
    }

    /// Tail GET /streams/<name>. A 1.2 GB SDK behind a silent spinner is the
    /// same defect as a silent `serve` — the user cannot tell fetching from
    /// hung — so every line goes to the surface as it arrives.
    func subscribeInstallStream(
        _ name: String,
        onLine: @escaping @Sendable (String) -> Void,
        onDone: @escaping @Sendable (Bool, String?) -> Void
    ) -> Task<Void, Never> {
        let endpoints = requestEndpoints(path: "/streams/\(name)")
        let token = self.token
        let relayPassword = box.relayPassword
        let urlSession = self.session
        return Task {
            for endpoint in endpoints {
                if Task.isCancelled { return }
                var req = URLRequest(url: endpoint.url)
                req.httpMethod = "GET"
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue(Backend.surface, forHTTPHeaderField: "X-Yaver-Surface")
                if endpoint.relay, let relayPassword, !relayPassword.isEmpty {
                    req.setValue(relayPassword, forHTTPHeaderField: "X-Relay-Password")
                }
                do {
                    let (bytes, resp) = try await urlSession.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        continue
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        guard line.hasPrefix("data:") else { continue }
                        let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        guard let data = payload.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                        else { continue }
                        // Same frame vocabulary the phone reads (see
                        // mobile/src/lib/quic.ts::subscribeStream): {type:"line",
                        // text} for output, {type:"result", status, error} for
                        // the verdict.
                        let kind = obj["type"] as? String ?? ""
                        if kind == "line", let text = obj["text"] as? String, !text.isEmpty {
                            onLine(text)
                        } else if kind == "result" {
                            let status = obj["status"] as? String ?? ""
                            onDone(status == "ok", obj["error"] as? String)
                            return
                        }
                    }
                    // The install stream DOES have a terminal frame, so an end
                    // without one means we never learned the verdict. Say that
                    // instead of implying success.
                    onDone(false, "the install stream ended before reporting a result")
                    return
                } catch {
                    if Task.isCancelled { return }
                    continue
                }
            }
            onDone(false, "could not reach the install log stream")
        }
    }

    /// Small POST helper for the JSON endpoints above.
    private func postJSON(_ path: String, _ body: [String: Any]) async throws -> Data {
        try await request("POST", path: path, jsonBody: body, failure: path)
    }

    /// A live redroid / Android screen frame (GET /droid/frame → PNG). Throws a
    /// readable message on 503 ("no android device attached") so the viewer can
    /// say so instead of showing nothing.
    func droidFrame(device: String? = nil) async throws -> Data {
        let path = device?.isEmpty == false
            ? "/droid/frame?device=\(device!.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? device!)"
            : "/droid/frame"
        return try await request("GET", path: path, failure: "no Android screen")
    }

    /// Feedback reports the box has collected (GET /feedback → a bare array).
    func listFeedback() async throws -> [FeedbackReport] {
        let data = try await request("GET", path: "/feedback", failure: "couldn't load feedback")
        return (try? JSONDecoder().decode([FeedbackReport].self, from: data)) ?? []
    }

    /// `confirm: true` is the user's second, deliberate tap after being told the
    /// runner already looks signed in — the only path allowed to reap a healthy
    /// session. Everything else is answered by the agent, not obeyed.
    func startRunnerAuth(_ runner: String, confirm: Bool = false) async throws -> RunnerAuthStartResult {
        try await ops(
            "runner_auth",
            [
                "op": "browser_start",
                "runner": runner,
                "trigger": confirm ? "confirmed" : "explicit",
                "confirm": confirm,
            ],
            as: RunnerAuthStartResult.self
        )
    }

    func runnerAuthStatus(sessionId: String) async throws -> RunnerAuthStartResult {
        try await ops("runner_auth", ["op": "browser_status", "sessionId": sessionId], as: RunnerAuthStartResult.self)
    }

    func startGitAuth(_ provider: String, host: String? = nil) async throws -> GitAuthSession {
        var payload: [String: Any] = ["provider": provider]
        if let host, !host.isEmpty { payload["host"] = host }
        return try await ops("git_connect", payload, as: GitAuthSession.self)
    }

    func gitAuthStatus(sessionId: String) async throws -> GitAuthSession {
        try await ops("git_connect_status", ["sessionId": sessionId], as: GitAuthSession.self)
    }

    func reload(mode: String = "dev", workDir: String? = nil) async throws -> ReloadResult {
        var payload: [String: Any] = ["mode": mode]
        if let workDir, !workDir.isEmpty { payload["workDir"] = workDir }
        return try await ops("reload", payload, as: ReloadResult.self)
    }

    /// MJPEG frame URL for the capture card — same `/capture/frame.jpg` the RN
    /// client polls. Bearer goes in the header on fetch; tvOS `AsyncImage` can't
    /// set headers, so callers fetch via `frameData()` instead.
    func captureFrameURL() -> URL? {
        URL(string: "http://\(box.host):\(box.port)/capture/frame.jpg")
    }

    /// A capture frame, or a real error — never a JSON error body dressed as JPEG.
    ///
    /// This discarded the HTTP response and returned whatever bytes arrived. When
    /// capture isn't running the agent answers `503` with a 43-byte JSON body
    /// (`{"error":"capture not running"}`); those bytes went straight to
    /// `UIImage(data:)`, which returns nil — so the tile showed no frame and no
    /// reason, forever. Check the status and carry the message out.
    func frameData() async throws -> Data {
        try await request("GET", path: "/capture/frame.jpg", failure: "capture frame unavailable")
    }

    private func request(_ method: String, path: String, jsonBody: [String: Any]? = nil, failure: String) async throws -> Data {
        let endpoints = requestEndpoints(path: path)
        guard !endpoints.isEmpty else { throw AgentError(message: "bad box host") }
        let body = try jsonBody.map { try JSONSerialization.data(withJSONObject: $0) }

        var lastError: Error = AgentError(message: failure)
        for endpoint in endpoints {
            var req = URLRequest(url: endpoint.url)
            req.httpMethod = method
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(Backend.surface, forHTTPHeaderField: "X-Yaver-Surface")
            if let body {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = body
            }
            if endpoint.relay, let pw = box.relayPassword, !pw.isEmpty {
                req.setValue(pw, forHTTPHeaderField: "X-Relay-Password")
            }
            do {
                let (data, resp) = try await session.data(for: req)
                guard let http = resp as? HTTPURLResponse else {
                    throw AgentError(message: "no response")
                }
                if !(200..<300).contains(http.statusCode) {
                    // The agent carries a structured `capabilityGap` alongside
                    // `error` on a 412 refusal (and on a /tasks 500). Carry BOTH
                    // out: the string for every existing call site, the gap for
                    // the ones that can render a fix.
                    let gap = FailureSignals.capabilityGapFromData(data)
                    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let err = obj["error"] as? String, !err.isEmpty {
                        throw AgentError(message: err, gap: gap, code: obj["code"] as? String)
                    }
                    if let gap {
                        throw AgentError(message: gap.summary, gap: gap)
                    }
                    lastError = AgentError(message: "\(failure) (\(http.statusCode))")
                    continue
                }
                return data
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
