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
    // The chat already renders groomed task output. Console is progressive
    // disclosure for genuine raw stdout only, otherwise it duplicates the
    // assistant answer and spends most of the television on the same text.
    @State private var showConsole = false
    @State private var streamMessage: String?
    @State private var streamRetrying = false
    @State private var reattachNonce = 0
    @State private var stream: Task<Void, Never>?
    @State private var reattachTask: Task<Void, Never>?
    @State private var reattachAttempt = 0
    @State private var rawCursor = 0

    @State private var reply = ""
    @State private var sending = false
    @State private var sendError: String?
    @State private var optimisticTurns: [TaskConversationTurn] = []

    // Optional project + MCP context. Inventory is shared with mobile/web,
    // while authority starts empty until the user chooses or taps Use latest.
    @State private var availableProjects: [ProjectSummary] = []
    @State private var pickedProjectPath: String?
    @State private var availableMCPServers: [String] = []
    @State private var pickedMCPServers: Set<String> = []
    @State private var yaverMcpOn = false
    @State private var availableRunners: [AgentRunnerSummary] = []
    @State private var pickedRunner = ""
    @State private var pickedModel = ""
    @State private var settingsChanged = false
    @State private var showTaskSettings = false

    private enum ReplyFocus: Hashable { case field, settings, send }
    @FocusState private var replyFocus: ReplyFocus?

    private static let consoleCap = 512 * 1024

    init(task: TaskSummary) {
        _task = State(initialValue: task)
        _status = State(initialValue: task.status)
        _pickedRunner = State(initialValue: RegisteredRunner.canonical(task.runner ?? ""))
        _pickedModel = State(initialValue: task.model ?? "")
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
        .onDisappear { stream?.cancel(); reattachTask?.cancel() }
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
        .sheet(isPresented: $showTaskSettings) { taskSettingsPanel }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Circle().fill(color(for: status ?? task.status)).frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.safeTitle).font(.system(size: 22, weight: .semibold)).lineLimit(2)
                Text([runnerLabel, modelLabel, statusLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 15)).foregroundStyle(.secondary)
            }
            Spacer()
            if runnerCoding {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("LIVE").font(.system(size: 14, weight: .bold)).foregroundStyle(.green)
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

                    if runnerCoding, displayTurns.last?.role != "assistant" {
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
                            // Automatic recovery needs no competing focusable
                            // control. The button appears only after the
                            // bounded ladder gives up.
                            if !streamRetrying {
                                Button("Reattach") {
                                    reattachTask?.cancel()
                                    reattachAttempt = 0
                                    streamRetrying = false
                                    self.streamMessage = nil
                                    reattachNonce += 1
                                }
                            }
                        }
                        .font(.system(size: 15))
                    }

                    if showConsole && (!cleanConsole.isEmpty || runnerCoding) {
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
                Button { showTaskSettings = true } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 22, weight: .bold))
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(.bordered)
                .focused($replyFocus, equals: .settings)
                .accessibilityLabel("Task settings")
                .accessibilityIdentifier("chat.followup-settings")
            }
            HStack(spacing: 10) {
                Label(runnerLabel, systemImage: "terminal.fill")
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                if !console.isEmpty || runnerCoding {
                    Button(showConsole ? "Hide live console" : "Show live console") { showConsole.toggle() }
                        .font(.system(size: 14, weight: .semibold))
                }
            }
        }
        .padding(.horizontal, 48).padding(.vertical, 16)
        .background(.ultraThinMaterial)
    }

    private var selectedProject: ProjectSummary? {
        guard let path = pickedProjectPath else { return nil }
        return availableProjects.first(where: { $0.path == path })
    }

    private var selectedRunner: AgentRunnerSummary? {
        availableRunners.first(where: { $0.canonicalId == RegisteredRunner.canonical(pickedRunner) })
    }

    private var selectedModel: AgentRunnerModel? {
        selectedRunner?.models.first(where: { $0.id == pickedModel })
    }

    private var taskSettingsPanel: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    settingsMenuRow(icon: "folder", title: "Project", value: selectedProject?.name ?? "No project") {
                        Button {
                            pickedProjectPath = nil
                            settingsChanged = true
                        } label: {
                            if pickedProjectPath == nil { Label("No project", systemImage: "checkmark") }
                            else { Text("No project") }
                        }
                        if let boxId = store.runnerBox()?.id,
                           let latest = store.lastProject(for: boxId, projects: availableProjects),
                           let path = latest.path {
                            Button("Use latest · \(latest.name)") {
                                pickedProjectPath = path
                                settingsChanged = true
                            }
                        }
                        if !availableProjects.isEmpty { Divider() }
                        ForEach(availableProjects) { project in
                            Button {
                                pickedProjectPath = project.path
                                settingsChanged = true
                            } label: {
                                if project.path == pickedProjectPath { Label(project.name, systemImage: "checkmark") }
                                else { Text(project.name) }
                            }
                        }
                    }

                    settingsMenuRow(icon: "cpu", title: "Runner", value: selectedRunner?.displayName ?? "Choose runner") {
                        ForEach(availableRunners.filter(\.installed)) { runner in
                            Button {
                                pickedRunner = runner.canonicalId
                                pickedModel = preferredModel(in: runner)?.id ?? ""
                                settingsChanged = true
                            } label: {
                                if runner.canonicalId == RegisteredRunner.canonical(pickedRunner) {
                                    Label(runner.displayName, systemImage: "checkmark")
                                } else { Text(runner.displayName) }
                            }
                        }
                    }

                    settingsMenuRow(icon: "sparkles", title: "Model", value: selectedModel?.name ?? (pickedModel.isEmpty ? "Runner default" : pickedModel)) {
                        Button {
                            pickedModel = ""
                            settingsChanged = true
                        } label: {
                            if pickedModel.isEmpty { Label("Runner default", systemImage: "checkmark") }
                            else { Text("Runner default") }
                        }
                        if selectedRunner?.models.isEmpty == false { Divider() }
                        ForEach(selectedRunner?.models ?? []) { model in
                            Button {
                                pickedModel = model.id
                                settingsChanged = true
                            } label: {
                                if model.id == pickedModel { Label(model.name, systemImage: "checkmark") }
                                else { Text(model.name) }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label("MCP tools", systemImage: "point.3.connected.trianglepath.dotted")
                                .font(.system(size: 22, weight: .semibold))
                            Spacer()
                            if let boxId = store.runnerBox()?.id,
                               store.lastMCPServersByDevice[boxId] != nil {
                                Button("Use latest") { useLatestMCP(for: boxId) }
                            }
                            if yaverMcpOn || !pickedMCPServers.isEmpty {
                                Button("Clear all") {
                                    yaverMcpOn = false
                                    pickedMCPServers.removeAll()
                                    settingsChanged = true
                                }
                            }
                        }
                        Text("Optional. No MCP is selected unless you choose one or tap Use latest.")
                            .font(.system(size: 14)).foregroundStyle(.secondary)
                        mcpToggle("Yaver MCP", selected: yaverMcpOn) {
                            yaverMcpOn.toggle(); settingsChanged = true
                        }
                        ForEach(availableMCPServers, id: \.self) { name in
                            mcpToggle(name, selected: pickedMCPServers.contains(name)) {
                                if pickedMCPServers.contains(name) { pickedMCPServers.remove(name) }
                                else { pickedMCPServers.insert(name) }
                                settingsChanged = true
                            }
                        }
                    }
                    .padding(22)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
                }
                .padding(40)
            }
            .navigationTitle("Task settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showTaskSettings = false } } }
        }
    }

    private func settingsMenuRow<Content: View>(
        icon: String, title: String, value: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 18) {
            Image(systemName: icon).font(.system(size: 24, weight: .semibold)).foregroundStyle(.blue).frame(width: 44)
            Text(title).font(.system(size: 22, weight: .semibold))
            Spacer()
            Menu(content: content) {
                HStack(spacing: 8) { Text(value).lineLimit(1); Image(systemName: "chevron.down") }
                    .font(.system(size: 18, weight: .semibold))
            }
            .disabled(title == "Runner" && availableRunners.filter(\.installed).isEmpty)
        }
        .padding(22)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private func mcpToggle(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 18, weight: .medium)); Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? .blue : .secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }

    private func preferredModel(in runner: AgentRunnerSummary) -> AgentRunnerModel? {
        runner.models.first(where: { $0.isDefault == true }) ?? runner.models.first
    }

    private func useLatestMCP(for boxId: String) {
        guard let pref = store.lastMCPServersByDevice[boxId] else { return }
        yaverMcpOn = pref.includeYaverMcp ?? false
        pickedMCPServers = Set(pref.mcpServers ?? []).intersection(Set(availableMCPServers))
        settingsChanged = true
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
        if let failure = taskFailureNotice,
           !rows.contains(where: { $0.role == "assistant" && $0.content == failure }) {
            rows.append(TaskConversationTurn(role: "assistant", content: failure, timestamp: nil))
        }
        for pending in task.pendingFollowUps ?? [] where !rows.contains(where: { $0.role == "user" && $0.content == pending.input }) {
            rows.append(TaskConversationTurn(role: "user", content: pending.input, timestamp: nil))
        }
        for optimistic in optimisticTurns where !rows.contains(where: { $0.role == optimistic.role && $0.content == optimistic.content }) {
            rows.append(optimistic)
        }
        return rows
    }

    /// A runner can accept POST /tasks and fail later (for example when the
    /// provider rejects an exhausted credit balance). Older agents put that
    /// refusal only in raw stdout, leaving the TV with a completed-looking
    /// conversation and no explanation. Promote known terminal failures into
    /// the same assistant lane used by mobile/web; do not route billing or
    /// model failures through sign-in.
    private var taskFailureNotice: String? {
        guard ["failed", "stopped"].contains((status ?? task.status ?? "").lowercased()) else { return nil }
        let raw = [task.resultText, task.output, console]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let kind = FailureSignals.classifyRunnerFailure(raw)
        if let explanation = FailureSignals.explainRunnerFailure(kind) {
            return "The task stopped: \(explanation.reason) \(explanation.action)"
        }
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "The task stopped before it produced a result. Open the live console for details, then retry once the runner is ready."
        }
        return "The task stopped: \(redactHomePaths(raw.split(separator: "\n").last.map(String.init) ?? raw))"
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

    private func loadConfiguration() async {
        guard store.runnerBox() != nil, let client = store.runnerClient() else { return }
        async let projectRows: [ProjectSummary]? = try? client.listProjects()
        async let serverRows: [McpServerSummary]? = try? client.listMCPServers()
        async let runnerRows: AgentRunnerList? = try? client.listRunners()
        let loadedProjects = (await projectRows) ?? []
        let loadedServers = (await serverRows) ?? []
        let loadedRunners = (await runnerRows)?.runners.filter(\.installed) ?? []
        availableProjects = loadedProjects
        availableMCPServers = loadedServers.map(\.name)
        availableRunners = loadedRunners
        if pickedRunner.isEmpty {
            pickedRunner = RegisteredRunner.canonical(task.runner ?? "")
        }
        if pickedRunner.isEmpty {
            pickedRunner = RegisteredRunner.canonical((await runnerRows)?.default ?? loadedRunners.first?.id ?? "")
        }
        if pickedModel.isEmpty, let runner = selectedRunner {
            pickedModel = preferredModel(in: runner)?.id ?? ""
        }
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
                switch tvChatFollowUpAction(
                    status: status ?? task.status,
                    runner: task.runner,
                    selectedRunner: pickedRunner,
                    settingsChanged: settingsChanged
                ) {
                case .continueCurrent:
                    try await client.continueTask(task.id, input: text)
                    await MainActor.run {
                        status = "running"
                    }
                case .fork(let runner):
                    let fork = try await client.forkTask(
                        task.id,
                        runner: runner,
                        model: pickedModel,
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
                            model: pickedModel.isEmpty ? task.model : pickedModel,
                            turns: displayTurns
                        )
                        status = fork.status ?? "queued"
                        console = ""
                        rawCursor = 0
                        streamMessage = nil
                        reattachNonce += 1
                        settingsChanged = false
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
        let currentID = task.id
        let s = await client.subscribeTaskOutput(
            taskId: currentID,
            rawSince: since,
            onRaw: { text, offset, full in
                Task { @MainActor in
                    if full { console = String(text.prefix(Self.consoleCap)) }
                    else { console = String((console + text).suffix(Self.consoleCap)) }
                    rawCursor = offset
                    streamMessage = nil
                    streamRetrying = false
                    reattachAttempt = 0
                }
            },
            onData: { _ in
                Task { @MainActor in
                    // Groomed compatibility output belongs in chat bubbles.
                    // Only onRaw may populate the console.
                    streamMessage = nil
                    streamRetrying = false
                }
            },
            onDone: { doneStatus in
                Task { @MainActor in
                    status = doneStatus
                    streamMessage = nil
                    streamRetrying = false
                    reattachAttempt = 0
                    await refreshDetail()
                }
            },
            onEnd: { kind, reason in
                Task { @MainActor in
                    await handleStreamEnd(kind, reason)
                }
            }
        )
        stream = s
    }

    /// Task streams can cross a relay and close after the runner succeeded but
    /// before the terminal `done` frame reaches the TV. The agent retains both
    /// output lanes, so re-subscribing with `rawSince` is lossless. Task chat
    /// used to ignore the shared recovery policy and strand the couch at a
    /// manual Reattach button even though WebPreview already self-healed.
    @MainActor
    private func handleStreamEnd(_ kind: FailureSignals.StreamEndKind, _ cause: String?) async {
        // Probe the real task operation before claiming its work is still
        // running. In the common dropped-final-frame case this refresh both
        // discovers the terminal status and seeds retained output.
        if kind == .interrupted {
            await refreshDetail()
            if !runnerCoding {
                reattachTask?.cancel()
                reattachAttempt = 0
                streamRetrying = false
                streamMessage = nil
                return
            }
        }
        let plan = FailureSignals.planStreamRecovery(
            end: kind,
            attempt: reattachAttempt,
            cause: cause
        )
        switch plan {
        case .idle:
            streamMessage = nil
            streamRetrying = false
        case let .reattach(_, delayMs, message):
            streamMessage = message
            streamRetrying = true
            reattachAttempt += 1
            reattachTask?.cancel()
            reattachTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                guard !Task.isCancelled else { return }
                await startStream()
            }
        case let .giveUp(message):
            streamMessage = message
            streamRetrying = false
        }
    }

    private var cleanConsole: String {
        Self.stripANSI(console)
    }

    private var runnerCoding: Bool {
        tvTaskIsRunnerCoding(status ?? task.status)
    }

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

    private var runnerLabel: String {
        switch task.runner?.lowercased() {
        case "claude", "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        case .some(let value) where !value.isEmpty: return value
        default: return "Runner"
        }
    }

    private var modelLabel: String {
        guard let model = task.model, !model.isEmpty else { return "" }
        return model.split(separator: "/").last.map(String.init) ?? model
    }

    private var statusLabel: String {
        let value = status ?? task.status ?? ""
        guard !value.isEmpty else { return "" }
        return value.prefix(1).uppercased() + value.dropFirst()
    }
}
