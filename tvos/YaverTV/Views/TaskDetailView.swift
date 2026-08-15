// TaskDetailView.swift — one continuous mobile-style conversation on tvOS.
//
// The old screen called a raw stdout terminal "Chat" and offered no reply
// field. A user had to back out, create another task, then find the new console.
// Mobile's mechanic is the contract: render user/assistant turns, show a sent
// message immediately, continue a live task in place, and silently fork a
// finished task to the same runner while carrying the visible conversation.
// The raw console remains available as progressive disclosure, not the primary
// interaction model.

import SwiftUI

struct TaskDetailView: View {
    @EnvironmentObject var store: YaverStore

    @State private var task: TaskSummary
    @State private var status: String?
    @State private var console = ""
    @State private var live = false
    @State private var showConsole = false
    @State private var streamMessage: String?
    @State private var reattachNonce = 0
    @State private var stream: Task<Void, Never>?
    @State private var rawCursor = 0

    @State private var reply = ""
    @State private var sending = false
    @State private var sendError: String?
    @State private var optimisticTurns: [TaskConversationTurn] = []

    // Optional project + MCP context, restored from the same per-device rows
    // mobile/web use. Neither is a gate to replying.
    @State private var availableProjects: [ProjectSummary] = []
    @State private var pickedProjectPath: String?
    @State private var availableMCPServers: [String] = []
    @State private var pickedMCPServers: Set<String> = []
    @State private var yaverMcpOn = true

    private enum ReplyFocus: Hashable { case field, send }
    @FocusState private var replyFocus: ReplyFocus?

    private static let consoleCap = 512 * 1024

    init(task: TaskSummary) {
        _task = State(initialValue: task)
        _status = State(initialValue: task.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            conversation
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .task { await loadConfiguration(); await refreshDetail() }
        .task(id: reattachNonce) { await startStream() }
        .onDisappear { stream?.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("UIKeyboardDidHideNotification"))) { _ in
            guard !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            DispatchQueue.main.async { replyFocus = .send }
        }
        .onChange(of: replyFocus) { oldFocus, newFocus in
            guard oldFocus == .field, newFocus == nil,
                  !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            DispatchQueue.main.async { replyFocus = .send }
        }
        .defaultFocus($replyFocus, .field)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Circle().fill(color(for: status ?? task.status)).frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.safeTitle).font(.system(size: 22, weight: .semibold)).lineLimit(2)
                Text([task.runner, task.model, status ?? task.status].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 15)).foregroundStyle(.secondary)
            }
            Spacer()
            if live {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("working").font(.system(size: 14, weight: .semibold)).foregroundStyle(.green)
                }
            }
            if task.tmuxSession?.isEmpty == false {
                NavigationLink(destination: SessionView(preselect: task.tmuxSession)) {
                    Label("Session", systemImage: "terminal.fill")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 48).padding(.vertical, 18)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(displayTurns) { turn in
                        bubble(turn)
                    }

                    if live, displayTurns.last?.role != "assistant" {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("The runner is working…")
                                .foregroundStyle(.secondary)
                        }
                        .padding(18)
                        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    }

                    if let streamMessage {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text(streamMessage).foregroundStyle(.orange)
                            Button("Reattach") {
                                self.streamMessage = nil
                                reattachNonce += 1
                            }
                        }
                        .font(.system(size: 15))
                    }

                    if showConsole {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Live console").font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                            Text(cleanConsole.isEmpty ? "Waiting for output…" : cleanConsole)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(cleanConsole.isEmpty ? .secondary : .primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(18)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
                    }

                    Color.clear.frame(height: 1).id("chat-bottom")
                }
                .padding(.horizontal, 48).padding(.vertical, 20)
            }
            .onChange(of: displayTurns.count) { _, _ in
                withAnimation(.none) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
            .onChange(of: console.count) { _, _ in
                guard showConsole else { return }
                withAnimation(.none) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let sendError {
                Text(sendError).font(.system(size: 14)).foregroundStyle(.orange).lineLimit(2)
            }
            HStack(spacing: 12) {
                // Match the new-vibe composer: vertical text fields trap the
                // Siri Remote's Down event, so a dictated reply could not
                // reach Send without backing out of the screen.
                TextField("Reply…", text: $reply)
                    .textFieldStyle(.plain)
                    .font(.system(size: 20))
                    .focused($replyFocus, equals: .field)
                    .accessibilityIdentifier("chat.reply")
                    .onMoveCommand { direction in
                        if direction == .down,
                           !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            replyFocus = .send
                        }
                    }
                    .onSubmit {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                            replyFocus = .send
                        }
                    }
                Button(sending ? "Sending…" : "Send") { sendReply() }
                    .buttonStyle(.borderedProminent)
                    .disabled(sending || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .focused($replyFocus, equals: .send)
                    .accessibilityIdentifier("chat.send-reply")
            }
            HStack(spacing: 10) {
                projectChip
                mcpChip
                Button(showConsole ? "Hide console" : "Show console") { showConsole.toggle() }
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                Text("Project and MCP are optional context")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 48).padding(.vertical, 16)
        .background(.ultraThinMaterial)
    }

    private var displayTurns: [TaskConversationTurn] {
        var rows = task.turns ?? []
        if rows.isEmpty, let title = task.title, !title.isEmpty {
            rows.append(TaskConversationTurn(role: "user", content: title, timestamp: nil))
        }
        if !rows.contains(where: { $0.role == "assistant" }) {
            let answer = (task.resultText?.isEmpty == false ? task.resultText : task.output) ?? ""
            if !answer.isEmpty {
                rows.append(TaskConversationTurn(role: "assistant", content: answer, timestamp: nil))
            }
        }
        for pending in task.pendingFollowUps ?? [] where !rows.contains(where: { $0.role == "user" && $0.content == pending.input }) {
            rows.append(TaskConversationTurn(role: "user", content: pending.input, timestamp: nil))
        }
        for optimistic in optimisticTurns where !rows.contains(where: { $0.role == optimistic.role && $0.content == optimistic.content }) {
            rows.append(optimistic)
        }
        return rows
    }

    private func bubble(_ turn: TaskConversationTurn) -> some View {
        let user = turn.role == "user"
        return HStack {
            if user { Spacer(minLength: 180) }
            VStack(alignment: .leading, spacing: 5) {
                Text(user ? "You" : "Yaver")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(user ? .blue : .secondary)
                Text(redactHomePaths(turn.content))
                    .font(.system(size: 17))
                    .frame(maxWidth: 900, alignment: .leading)
            }
            .padding(18)
            .background(user ? Color.blue.opacity(0.2) : Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
            if !user { Spacer(minLength: 180) }
        }
    }

    private var projectChip: some View {
        Menu {
            Button { pickedProjectPath = nil } label: {
                if pickedProjectPath == nil { Label("No project (optional)", systemImage: "checkmark") }
                else { Text("No project (optional)") }
            }
            if !availableProjects.isEmpty { Divider() }
            ForEach(availableProjects) { project in
                Button {
                    pickedProjectPath = project.path
                    if let boxId = store.runnerBox()?.id { store.rememberProject(project, for: boxId) }
                } label: {
                    if pickedProjectPath == project.path { Label(project.name, systemImage: "checkmark") }
                    else { Text(project.name) }
                }
            }
        } label: {
            Label(projectLabel, systemImage: "folder")
                .font(.system(size: 14, weight: .semibold))
        }
    }

    private var projectLabel: String {
        guard let path = pickedProjectPath else { return "No project · optional" }
        return availableProjects.first(where: { $0.path == path })?.name
            ?? path.split(separator: "/").last.map(String.init)
            ?? "Project"
    }

    private var mcpChip: some View {
        Menu {
            Button {
                yaverMcpOn.toggle()
                persistMCP()
            } label: {
                if yaverMcpOn { Label("yaver (on)", systemImage: "checkmark") }
                else { Text("yaver (off)") }
            }
            if !availableMCPServers.isEmpty { Divider() }
            ForEach(availableMCPServers, id: \.self) { name in
                Button {
                    if pickedMCPServers.contains(name) { pickedMCPServers.remove(name) }
                    else { pickedMCPServers.insert(name) }
                    persistMCP()
                } label: {
                    if pickedMCPServers.contains(name) { Label(name, systemImage: "checkmark") }
                    else { Text(name) }
                }
            }
        } label: {
            Label(yaverMcpOn ? "yaver · \(pickedMCPServers.count) MCP" : "MCP optional", systemImage: "platter.2.filled.ipad")
                .font(.system(size: 14, weight: .semibold))
        }
    }

    private func persistMCP() {
        guard let boxId = store.runnerBox()?.id else { return }
        store.rememberMCPServers(Array(pickedMCPServers), includeYaverMcp: yaverMcpOn, for: boxId)
    }

    private func loadConfiguration() async {
        guard let boxId = store.runnerBox()?.id, let client = store.runnerClient() else { return }
        if let pref = store.lastMCPServersByDevice[boxId] {
            yaverMcpOn = pref.includeYaverMcp ?? true
            pickedMCPServers = Set(pref.mcpServers ?? [])
        }
        async let projectRows: [ProjectSummary]? = try? client.listProjects()
        async let serverRows: [McpServerSummary]? = try? client.listMCPServers()
        let loadedProjects = (await projectRows) ?? []
        let loadedServers = (await serverRows) ?? []
        availableProjects = loadedProjects
        pickedProjectPath = store.lastProject(for: boxId, projects: loadedProjects)?.path
        availableMCPServers = loadedServers.map(\.name)
        pickedMCPServers = pickedMCPServers.intersection(Set(availableMCPServers))
    }

    private func sendReply() {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        guard let client = store.runnerClient() else {
            sendError = store.machineSplitActive
                ? "Your AI runner machine needs the relay to be reachable from this TV."
                : "No machine selected"
            return
        }

        let optimistic = TaskConversationTurn(
            role: "user", content: text,
            timestamp: ISO8601DateFormatter().string(from: Date()))
        optimisticTurns.append(optimistic)
        reply = ""
        sending = true
        sendError = nil

        Task {
            do {
                switch tvChatFollowUpAction(status: status ?? task.status, runner: task.runner) {
                case .continueCurrent:
                    try await client.continueTask(task.id, input: text)
                    await MainActor.run {
                        status = "running"
                        live = true
                    }
                case .forkSameRunner(let runner):
                    let fork = try await client.forkTask(
                        task.id,
                        runner: runner,
                        input: text,
                        projectDir: pickedProjectPath,
                        mcpServers: Array(pickedMCPServers),
                        includeYaverMcp: yaverMcpOn
                    )
                    await MainActor.run {
                        stream?.cancel()
                        task = TaskSummary(
                            id: fork.taskId,
                            title: task.title,
                            status: fork.status ?? "queued",
                            runner: fork.runnerId,
                            model: task.model,
                            turns: displayTurns
                        )
                        status = fork.status ?? "queued"
                        console = ""
                        rawCursor = 0
                        streamMessage = nil
                        reattachNonce += 1
                    }
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
                await refreshDetail()
                await MainActor.run { sending = false }
            } catch {
                await MainActor.run {
                    optimisticTurns.removeAll { $0.id == optimistic.id }
                    if reply.isEmpty { reply = text }
                    sendError = error.localizedDescription
                    sending = false
                }
            }
        }
    }

    private func refreshDetail() async {
        guard let client = store.runnerClient() else { return }
        do {
            let detail = try await client.task(task.id)
            await MainActor.run {
                task = detail
                status = detail.status
                optimisticTurns.removeAll { optimistic in
                    (detail.turns ?? []).contains { $0.role == optimistic.role && $0.content == optimistic.content }
                        || (detail.pendingFollowUps ?? []).contains { $0.input == optimistic.content }
                }
            }
        } catch {
            // The SSE still carries the live operation. A detail refresh is
            // advisory and must never replace a working chat with an error.
        }
    }

    private func startStream() async {
        stream?.cancel()
        guard let client = store.runnerClient() else {
            streamMessage = "No machine selected"
            return
        }
        let since = rawCursor
        live = false
        let currentID = task.id
        let s = await client.subscribeTaskOutput(
            taskId: currentID,
            rawSince: since,
            onRaw: { text, offset, full in
                Task { @MainActor in
                    if full { console = String(text.prefix(Self.consoleCap)) }
                    else { console = String((console + text).suffix(Self.consoleCap)) }
                    rawCursor = offset
                    live = !full
                }
            },
            onDone: { doneStatus in
                Task { @MainActor in
                    status = doneStatus
                    live = false
                    await refreshDetail()
                }
            },
            onEnd: { kind, reason in
                Task { @MainActor in
                    live = false
                    switch kind {
                    case .done, .cancelled: streamMessage = nil
                    case .interrupted: streamMessage = reason ?? "the conversation stream stopped"
                    }
                }
            }
        )
        stream = s
    }

    private var cleanConsole: String { Self.stripANSI(console) }

    private static func stripANSI(_ s: String) -> String {
        var out = ""
        var state = 0 // 0=text 1=esc 2=csi 3=osc
        for ch in s.unicodeScalars {
            switch state {
            case 0:
                if ch == "\u{1B}" { state = 1 } else { out.unicodeScalars.append(ch) }
            case 1:
                if ch == "[" { state = 2 }
                else if ch == "]" { state = 3 }
                else { state = 0 }
            case 2:
                if ch.value >= 0x40 && ch.value <= 0x7E { state = 0 }
            case 3:
                if ch == "\u{07}" { state = 0 }
                else if ch == "\u{1B}" { state = 1 }
                else if ch == "\\" { state = 0 }
            default: state = 0
            }
        }
        return out
    }

    private func color(for value: String?) -> Color {
        switch (value ?? "").lowercased() {
        case "running": return .green
        case "queued": return .blue
        case "review": return .purple
        case "completed": return .gray
        case "failed", "stopped": return .red
        default: return .secondary
        }
    }
}
