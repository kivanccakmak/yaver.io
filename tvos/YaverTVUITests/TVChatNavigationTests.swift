// TVChatNavigationTests.swift — Siri Remote focus contract for native Chat.
//
// This is deliberately a no-backend navigation arc. Task history may be slow
// or unavailable; the composer entry must still exist, own focus, and lead to
// a prompt whose next downward focus stop is Start. That is the couch mechanic,
// and it can be proven without a production token or mutable server fixture.

import XCTest
import Network

final class TVChatNavigationTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDirectChatRouteOpensKeyboardWithoutStartPage() throws {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()

        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8), "Chat must expose New vibe even while task history fails or loads")
        XCTAssertTrue(newVibe.hasFocus, "Direct Chat route must default focus to New vibe")

        XCUIRemote.shared.press(.select)
        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "Selecting New vibe must open the composer")
        XCTAssertFalse(app.buttons["chat.start-vibe"].exists, "New vibe must not add a second Start page")
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "Selecting New vibe must activate the tvOS keyboard without another Select press"
        )
    }

    func testNewVibeIsOnlyTheSystemKeyboard() throws {
        let app = launchChat()
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        // The removed composer widget must never return. Native tvOS/iPhone
        // keyboard input is the entire New vibe surface.
        XCTAssertFalse(app.buttons["chat.task-settings"].exists)
        XCTAssertFalse(app.staticTexts["Start a session"].exists)
        XCTAssertFalse(app.staticTexts["Starting session…"].exists)
    }

    func testMenuReturnsFromDevicesSheetAndVisibleBackExists() throws {
        let app = launchDashboard()
        XCTAssertTrue(app.buttons["dashboard.chat"].waitForExistence(timeout: 8))

        // One horizontal dashboard rail: Chat → Vibing → Devices → Settings.
        // Devices is two Rights from Chat.
        XCUIRemote.shared.press(.right)
        XCUIRemote.shared.press(.right)
        XCUIRemote.shared.press(.select)

        let back = app.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 8), "The machine picker needs a visible way back, not only an undocumented Menu gesture")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(app.buttons["dashboard.chat"].waitForExistence(timeout: 5), "Menu must dismiss Devices to the dashboard")
    }

    func testMenuUnwindsComposerThenChat() throws {
        let app = launchDashboard()
        let chat = app.buttons["dashboard.chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 8))
        XCTAssertTrue(chat.hasFocus)

        XCUIRemote.shared.press(.select)
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.textFields["chat.prompt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        // First Menu closes the keyboard; second Menu dismisses the one-step
        // prompt surface. There is no intermediate Start/Cancel page.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 3),
            "The first Menu press must close the system keyboard"
        )
        // Do not send the sheet-dismiss press during the keyboard's dismissal
        // animation. tvOS drops that second remote event; a real user cannot
        // press both at the same timestamp, but the old test did exactly that.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(newVibe.waitForExistence(timeout: 5), "Menu must dismiss the composer to Chat")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(chat.waitForExistence(timeout: 5), "Menu must pop Chat to the dashboard")
    }

    func testComposerPromptIsActiveTextResponder() throws {
        // Simulator proxy for Siri Remote dictation. tvOS Simulator cannot
        // emit the mic button at all (hardware-only, see deploy-tvos.sh), but
        // Mac keyboard events reach a field ONLY when the UIKit editing session
        // is active — the same responder the mic dictates into on a real TV.
        // A focused-but-not-editing field (the original defect) inserts nothing.
        let app = launchChat()
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "Selecting New vibe must activate the tvOS keyboard without another Select press"
        )

        prompt.typeText("hello couch")
        var value = prompt.value as? String ?? ""
        for _ in 0..<10 where !value.contains("hello") {
            sleep(1)
            value = prompt.value as? String ?? ""
        }
        XCTAssertTrue(
            value.contains("hello couch"),
            "Typing must land in the prompt — the field must be the active text-input responder, not merely focus-ring-selected. Got value: '\(value)'"
        )

        // Menu still closes the native keyboard. There is deliberately no
        // composer widget or settings button underneath it.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 3),
            "The first Menu press must close the system keyboard"
        )
        XCTAssertFalse(app.buttons["chat.task-settings"].exists)
        XCTAssertFalse(app.staticTexts["Starting session…"].exists)
    }

    func testDoneCreatesExactlyOneTaskAndOpensItsLiveConversation() throws {
        let server = try TVChatHTTPFixture()
        addTeardownBlock { server.stop() }

        let app = XCUIApplication()
        let boxJSON = #"[{"id":"handoff-box","name":"Handoff Test","host":"127.0.0.1","port":\#(server.port)}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "handoff-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "handoff-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()

        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)

        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        prompt.typeText("Audit the couch handoff")

        // Transcription is composition, not consent to send. The former
        // implementation POSTed on the first two characters and this fixture
        // caught the partial task before Done was pressed.
        RunLoop.current.run(until: Date().addingTimeInterval(0.75))
        XCTAssertEqual(server.createCount, 0, "partial/in-progress text must never create a task")

        // A newline is the simulator's explicit Return/Done event. The
        // physical-device complement is the iPhone Apple TV Remote blue Done
        // key, which reaches this same native TextField submit action.
        prompt.typeText("\n")

        let createDeadline = Date().addingTimeInterval(5)
        while server.createCount == 0 && Date() < createDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertEqual(
            server.createCount, 1,
            "Done must produce one POST /tasks before navigation. UI: \(app.debugDescription)"
        )
        XCTAssertTrue(
            app.keyboards.firstMatch.exists,
            "the native keyboard must stay up while POST /tasks is pending"
        )
        XCTAssertFalse(app.staticTexts["Starting session…"].exists,
                       "New vibe must never expose an app-owned loading widget")

        let userTurn = app.descendants(matching: .any)["chat.user-turn"]
        XCTAssertTrue(userTurn.waitForExistence(timeout: 8), "Done must route to the exact created task's chat")
        XCTAssertEqual(userTurn.label, "Audit the couch handoff")
        XCTAssertTrue(
            app.descendants(matching: .any)["chat.runner-working"].waitForExistence(timeout: 3),
            "queued/running work must be named while output is pending"
        )
        let assistantTurn = app.descendants(matching: .any)["chat.assistant-turn"]
        XCTAssertTrue(
            assistantTurn.waitForExistence(timeout: 8),
            "groomed task SSE output must stream into the assistant conversation lane"
        )
        XCTAssertEqual(assistantTurn.label, "I am checking the handoff now.")
        XCTAssertTrue(app.textFields["chat.reply"].exists, "the created conversation must expose the next-turn reply field")
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 3),
            "Task detail must match the conversation screen directly; its reply field must not reopen the keyboard"
        )

        RunLoop.current.run(until: Date().addingTimeInterval(0.75))
        XCTAssertEqual(server.createCount, 1, "duplicate submit/focus callbacks must still produce one POST /tasks")
        XCTAssertEqual(server.createdTitle, "Audit the couch handoff")
        XCTAssertTrue(server.sawAuthorizedCreate, "the handoff must preserve the same bearer-auth boundary as other task clients")

        // Stay inside the same running task and send the next turn. This is the
        // contract the former test omitted: a green New Vibe handoff does not
        // prove that the Task reply field reaches /continue.
        let reply = app.textFields["chat.reply"]
        XCTAssertTrue(reply.hasFocus, "task conversation must leave focus on its reply field")
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        reply.typeText("Keep auditing")
        RunLoop.current.run(until: Date().addingTimeInterval(0.75))
        XCTAssertEqual(server.continueCount, 0, "transcription alone must not send a partial follow-up")
        reply.typeText("\n")

        let continueDeadline = Date().addingTimeInterval(5)
        while server.continueCount == 0 && Date() < continueDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertEqual(server.continueCount, 1, "Done must produce exactly one POST /tasks/{id}/continue")
        XCTAssertEqual(server.continuedInput, "Keep auditing")
        XCTAssertTrue(server.sawAuthorizedContinue, "the follow-up must preserve the TV bearer boundary")
    }

    func testRunnerQuestionRendersAndAnswersInsideTaskConversation() throws {
        let server = try TVChatHTTPFixture(questionMode: true)
        addTeardownBlock { server.stop() }

        let app = XCUIApplication()
        let boxJSON = #"[{"id":"question-box","name":"Question Test","host":"127.0.0.1","port":\#(server.port)}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "handoff-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "question-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()

        XCTAssertTrue(app.buttons["chat.new-vibe"].waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.typeText("Ask before choosing")
        prompt.typeText("\n")

        XCTAssertTrue(
            app.descendants(matching: .any)["chat.agent-question"].waitForExistence(timeout: 10),
            "agent_question must become a visible card in the same Task conversation"
        )
        XCTAssertTrue(app.staticTexts["Which approach?"].exists)
        let fast = app.buttons["Fast"]
        XCTAssertTrue(fast.exists, "choice questions must expose their actual answers as focusable buttons")
        for _ in 0..<8 where !fast.hasFocus {
            XCUIRemote.shared.press(.up)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertTrue(fast.hasFocus, "the Siri Remote must be able to reach a question choice from the composer")
        XCUIRemote.shared.press(.select)

        let answerDeadline = Date().addingTimeInterval(5)
        while server.answerCount == 0 && Date() < answerDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertEqual(server.answerCount, 1, "one choice must produce exactly one POST /tasks/{id}/answer")
        XCTAssertEqual(server.answeredValue, "Fast")
        XCTAssertTrue(server.sawAuthorizedAnswer, "question answers must preserve the TV bearer boundary")
    }

    private func launchDashboard() -> XCUIApplication {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            // Any unrecognised value means dashboard and overrides a stale
            // deep-route value left in simulator defaults.
            "-yaver.tv.startAt", "dashboard",
        ]
        app.launch()
        return app
    }

    private func launchChat() -> XCUIApplication {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()
        return app
    }
}

/// A real loopback HTTP server for the UI arc above. It intentionally speaks
/// the production REST/SSE contract instead of injecting app state: the test
/// can only pass if the app performs one POST, follows the returned task ID,
/// subscribes to that task's output route, and renders the bytes it receives.
private final class TVChatHTTPFixture: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "io.yaver.tests.tv-chat-http")
    private let lock = NSLock()
    private var _createCount = 0
    private var _createdTitle = ""
    private var _sawAuthorizedCreate = false
    private var _continueCount = 0
    private var _continuedInput = ""
    private var _sawAuthorizedContinue = false
    private var _answerCount = 0
    private var _answeredValue = ""
    private var _sawAuthorizedAnswer = false
    private let questionMode: Bool
    private var completed = false
    // Network.framework does not retain accepted connections for the
    // listener. Keep each one alive through the orderly response EOF; letting
    // the last reference disappear immediately after `send` produces an RST.
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    private(set) var port: UInt16 = 0

    var createCount: Int { locked { _createCount } }
    var createdTitle: String { locked { _createdTitle } }
    var sawAuthorizedCreate: Bool { locked { _sawAuthorizedCreate } }
    var continueCount: Int { locked { _continueCount } }
    var continuedInput: String { locked { _continuedInput } }
    var sawAuthorizedContinue: Bool { locked { _sawAuthorizedContinue } }
    var answerCount: Int { locked { _answerCount } }
    var answeredValue: String { locked { _answeredValue } }
    var sawAuthorizedAnswer: Bool { locked { _sawAuthorizedAnswer } }

    init(questionMode: Bool = false) throws {
        self.questionMode = questionMode
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        var startupError: NWError?
        var chosenPort: UInt16 = 0
        listener.stateUpdateHandler = { [weak listener] state in
            switch state {
            case .ready:
                chosenPort = listener?.port?.rawValue ?? 0
                ready.signal()
            case .failed(let error):
                startupError = error
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success,
              startupError == nil,
              chosenPort != 0 else {
            listener.cancel()
            throw startupError ?? NSError(
                domain: "TVChatHTTPFixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "loopback server did not become ready"]
            )
        }
        port = chosenPort
    }

    func stop() {
        listener.cancel()
        queue.sync {
            connections.values.forEach { $0.cancel() }
            connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        connections[ObjectIdentifier(connection)] = connection
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, _, error in
            guard let self else { connection.cancel(); return }
            var next = buffer
            if let data { next.append(data) }
            if self.requestIsComplete(next) {
                self.respond(to: next, on: connection)
            } else if error == nil {
                self.receive(on: connection, buffer: next)
            } else {
                connection.cancel()
            }
        }
    }

    private func requestIsComplete(_ data: Data) -> Bool {
        guard let text = String(data: data, encoding: .utf8),
              let headerEnd = text.range(of: "\r\n\r\n") else { return false }
        let headers = String(text[..<headerEnd.lowerBound])
        let length = headers.split(separator: "\n").first { line in
            line.lowercased().hasPrefix("content-length:")
        }.flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") } ?? 0
        let bodyStart = text.distance(from: text.startIndex, to: headerEnd.upperBound)
        return data.count >= bodyStart + length
    }

    private func respond(to data: Data, on connection: NWConnection) {
        guard let request = String(data: data, encoding: .utf8),
              let requestLine = request.split(separator: "\r\n", maxSplits: 1).first else {
            sendJSON(#"{"error":"bad request"}"#, status: "400 Bad Request", on: connection)
            return
        }
        let pieces = requestLine.split(separator: " ")
        let method = pieces.first.map(String.init) ?? ""
        let rawPath = pieces.count > 1 ? String(pieces[1]) : "/"
        let path = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawPath

        switch (method, path) {
        case ("GET", "/tasks"):
            sendJSON(#"{"tasks":[]}"#, on: connection)
        case ("POST", "/ops"):
            sendJSON(#"{"count":0,"sessions":[]}"#, on: connection)
        case ("GET", "/projects"):
            sendJSON(#"{"projects":[]}"#, on: connection)
        case ("GET", "/mcp/servers"):
            sendJSON(#"{"servers":[]}"#, on: connection)
        case ("GET", "/agent/runners"):
            sendJSON(#"{"runners":[{"id":"opencode","name":"OpenCode","installed":true,"ready":true,"isDefault":true,"models":[]}],"default":"opencode"}"#, on: connection)
        case ("POST", "/tasks"):
            recordCreate(request)
            // Keep the operation pending long enough for the UI arc to prove
            // that the system keyboard remains the only visible input surface.
            queue.asyncAfter(deadline: .now() + 0.75) { [weak self] in
                self?.sendJSON(#"{"taskId":"task-iphone-handoff","status":"queued","runnerId":"opencode"}"#, status: "201 Created", on: connection)
            }
        case ("GET", "/tasks/task-iphone-handoff"):
            sendTaskDetail(on: connection)
        case ("GET", "/tasks/task-iphone-handoff/output"):
            streamTask(on: connection)
        case ("POST", "/tasks/task-iphone-handoff/continue"):
            recordContinue(request)
            sendJSON(#"{"ok":true,"taskId":"task-iphone-handoff","status":"running"}"#, on: connection)
        case ("POST", "/tasks/task-iphone-handoff/answer"):
            recordAnswer(request)
            sendJSON(#"{"ok":true}"#, on: connection)
        default:
            sendJSON(#"{"error":"not found"}"#, status: "404 Not Found", on: connection)
        }
    }

    private func recordCreate(_ request: String) {
        let body = request.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
        let title: String
        if let data = body.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            title = json["title"] as? String ?? ""
        } else {
            title = ""
        }
        lock.lock()
        _createCount += 1
        _createdTitle = title
        _sawAuthorizedCreate = request.range(of: "Authorization: Bearer handoff-audit", options: .caseInsensitive) != nil
        lock.unlock()
    }

    private func recordContinue(_ request: String) {
        let body = request.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
        let input: String
        if let data = body.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            input = json["input"] as? String ?? ""
        } else {
            input = ""
        }
        lock.lock()
        _continueCount += 1
        _continuedInput = input
        _sawAuthorizedContinue = request.range(of: "Authorization: Bearer handoff-audit", options: .caseInsensitive) != nil
        lock.unlock()
    }

    private func recordAnswer(_ request: String) {
        let body = request.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
        let answer: String
        if let data = body.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            answer = json["answer"] as? String ?? ""
        } else {
            answer = ""
        }
        lock.lock()
        _answerCount += 1
        _answeredValue = answer
        _sawAuthorizedAnswer = request.range(of: "Authorization: Bearer handoff-audit", options: .caseInsensitive) != nil
        lock.unlock()
    }

    private func sendTaskDetail(on connection: NWConnection) {
        let done = locked { completed }
        let title = locked { _createdTitle.isEmpty ? "Audit the couch handoff" : _createdTitle }
        let turns: [[String: Any]] = done
            ? [["role": "user", "content": title], ["role": "assistant", "content": "I am checking the handoff now."]]
            : [["role": "user", "content": title]]
        let task: [String: Any] = [
            "id": "task-iphone-handoff",
            "title": title,
            "status": done ? "completed" : "running",
            "runner": "opencode",
            "turns": turns,
        ]
        let payload = try! JSONSerialization.data(withJSONObject: ["ok": true, "task": task])
        sendJSON(String(decoding: payload, as: UTF8.self), on: connection)
    }

    private func streamTask(on connection: NWConnection) {
        // Use real HTTP/1.1 chunk framing. A header-only, close-delimited body
        // is ambiguous to URLSession when bytes arrive later and made the
        // fixture drop valid SSE even though the production endpoint streams.
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(headers.utf8) + chunk(": connected\n\n"), completion: .contentProcessed { error in
            guard error == nil else { connection.cancel(); return }
            self.queue.asyncAfter(deadline: .now() + 1.0) {
                let output = "data: {\"type\":\"output\",\"text\":\"I am checking the handoff now.\",\"offset\":31}\n\n"
                connection.send(content: self.chunk(output), completion: .contentProcessed { error in
                    guard error == nil else { connection.cancel(); return }
                    if self.questionMode && self.answerCount == 0 {
                        let question = "data: {\"type\":\"agent_question\",\"question\":{\"id\":\"q-tv-choice\",\"taskId\":\"task-iphone-handoff\",\"prompt\":\"Which approach?\",\"header\":\"Approach\",\"kind\":\"choice\",\"choices\":[\"Safe\",\"Fast\"],\"multi\":false,\"createdAtMs\":1,\"timeoutSec\":300}}\n\n"
                        connection.send(content: self.chunk(question), completion: .contentProcessed { error in
                            if error != nil { connection.cancel() }
                        })
                        return
                    }
                    self.queue.asyncAfter(deadline: .now() + 8.0) {
                        self.locked { self.completed = true }
                        let done = "data: {\"type\":\"done\",\"status\":\"completed\"}\n\n"
                        // `isComplete` emits an orderly EOF. Cancelling again
                        // from the completion handler turns that FIN into a
                        // reset on Network.framework, so URLSession can discard
                        // an otherwise valid final frame as `ECONNRESET`.
                        connection.send(content: self.chunk(done) + Data("0\r\n\r\n".utf8), isComplete: true, completion: .contentProcessed { _ in
                            self.finish(connection)
                        })
                    }
                })
            }
        })
    }

    private func sendJSON(_ json: String, status: String = "200 OK", on connection: NWConnection) {
        let body = Data(json.utf8)
        let headers = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(headers.utf8) + body, isComplete: true, completion: .contentProcessed { _ in
            self.finish(connection)
        })
    }

    private func chunk(_ text: String) -> Data {
        let body = Data(text.utf8)
        return Data(String(format: "%X\r\n", body.count).utf8) + body + Data("\r\n".utf8)
    }

    private func finish(_ connection: NWConnection) {
        // Give URLSession time to consume Content-Length / stream EOF before
        // releasing the connection object. This remains bounded and local to
        // the disposable UI-test fixture.
        queue.asyncAfter(deadline: .now() + 0.5) {
            self.connections.removeValue(forKey: ObjectIdentifier(connection))
        }
    }

    @discardableResult
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
