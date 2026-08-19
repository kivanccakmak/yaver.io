// TaskComposerView.swift — START a vibe from the couch (POST /tasks).
//
// This closes the gap that made the TV a monitor instead of a surface: the
// client had createTask (AgentClient.swift) since 2026-08-03 and no view ever
// called it, so the TV could watch work happen and never start any. The
// composer mirrors the web dispatch funnel's body. It starts from the shared
// per-device preference, then lets this one task pin a measured runner/model,
// plus the opencode mode/goal/askMode fields so a TV-started task is
// indistinguishable from one started in the dashboard.
//
// Project + MCP inventory comes from the same rows as mobile/web, but scope
// starts empty. Remembered values require an explicit Use latest action.
// Per-task choices live behind ONE ellipsis button: the prompt remains the
// primary action while project, runner, model and zero-or-many MCPs remain
// reachable before Send.

import SwiftUI

struct TaskComposerView: View {
    @EnvironmentObject var store: YaverStore
    @Environment(\.dismiss) private var dismiss

    /// Optional project to preselect (e.g. "Start a vibe" from a project's
    /// dead-end preview screen). Matched by name against /projects.
    private let initialProjectName: String?
    private let onCreated: (TaskSummary) -> Void

    init(
        initialProjectName: String? = nil,
        onCreated: @escaping (TaskSummary) -> Void = { _ in }
    ) {
        self.initialProjectName = initialProjectName
        self.onCreated = onCreated
    }

    @State private var prompt = ""
    @State private var creating = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool
    @State private var showTaskSettings = false
    // Project/MCP picker state (runner box /projects, same as mobile/web).
    // Both are optional task context: a prompt can be sent immediately with
    // the per-device default runner and no project/MCP setup ceremony.
    @State private var availableProjects: [ProjectSummary] = []
    @State private var pickedProjectPath: String?
    @State private var projectSelectionLoaded = false
    @State private var availableMCPServers: [String] = []
    @State private var pickedMCPServers: Set<String> = []
    @State private var yaverMcpOn = false
    @State private var mcpSelectionLoaded = false
    @State private var availableRunners: [AgentRunnerSummary] = []
    @State private var pickedRunner = ""
    @State private var pickedModel = ""
    @State private var runnerSelectionLoaded = false
    private var runnerBoxId: String? { store.runnerBox()?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            header

            // Native SwiftUI TextField is intentional: tvOS attaches Siri
            // Remote dictation to the system text-input surface (the same
            // path used by YouTube). A UIKit wrapper can accept keyboard text
            // while losing the remote's dictation context.
            TextField("Speak your task — hold Siri on the remote", text: $prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 24))
                .lineLimit(3, reservesSpace: true)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .background(.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                .focused($promptFocused)
                .accessibilityIdentifier("chat.prompt")
                .disabled(creating)
                .onSubmit { create() }
                .frame(minHeight: 66)

            if creating {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Starting Deep Audit…")
                        .font(.system(size: 17, weight: .semibold))
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(taskContextSummary)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("Hold Siri on the remote and speak. Release, then press Done.")
                        .font(.system(size: 14))
                        .foregroundStyle(.tertiary)
                }
            }
            if let error {
                Text(error)
                    .font(.system(size: 15))
                    .foregroundStyle(.orange)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(40)
        .frame(maxWidth: 900)
        .task { await loadPickerState() }
        .onAppear { promptFocused = true }
        .defaultFocus($promptFocused, true)
        .sheet(isPresented: $showTaskSettings) {
            taskSettingsPanel
        }
        #if os(tvOS)
        // The first Menu press belongs to the system keyboard. Once it is
        // gone, the next Menu press must dismiss this one-step sheet back to
        // Chat; otherwise the couch flow has no reliable native back route.
        .onExitCommand { dismiss() }
        #endif
    }

    private var header: some View {
        HStack {
            Image(systemName: "wand.and.stars").font(.system(size: 26)).foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 3) {
                Text("New vibe").font(.system(size: 30, weight: .bold))
                Text("Deep Audit").font(.system(size: 15, weight: .semibold)).foregroundStyle(.blue)
            }
            Spacer()
            Button {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil, from: nil, for: nil
                )
                showTaskSettings = true
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 24, weight: .bold))
                    .frame(width: 54, height: 54)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Task settings")
            .accessibilityIdentifier("chat.task-settings")
        }
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

    private var taskContextSummary: String {
        let project = selectedProject?.name ?? "No project"
        let runner = selectedRunner?.displayName ?? "Runner default"
        let model = selectedModel?.name ?? (pickedModel.isEmpty ? "model default" : pickedModel)
        let mcpCount = pickedMCPServers.count + (yaverMcpOn ? 1 : 0)
        let mcp = mcpCount == 0 ? "No MCP" : "\(mcpCount) MCP"
        return "\(project) · \(runner) / \(model) · \(mcp)"
    }

    private var taskSettingsPanel: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    settingsMenuRow(
                        icon: "folder",
                        title: "Project",
                        value: selectedProject?.name ?? "No project"
                    ) {
                        Button {
                            projectSelectionLoaded = true
                            pickedProjectPath = nil
                        } label: {
                            if pickedProjectPath == nil { Label("No project", systemImage: "checkmark") }
                            else { Text("No project") }
                        }
                        if let latest = latestProject, let path = latest.path {
                            Button("Use latest · \(latest.name)") {
                                projectSelectionLoaded = true
                                pickedProjectPath = path
                            }
                        }
                        if !availableProjects.isEmpty { Divider() }
                        ForEach(availableProjects) { project in
                            Button {
                                projectSelectionLoaded = true
                                pickedProjectPath = project.path
                                if let boxId = runnerBoxId { store.rememberProject(project, for: boxId) }
                            } label: {
                                if project.path == pickedProjectPath { Label(project.name, systemImage: "checkmark") }
                                else { Text(project.name) }
                            }
                        }
                    }

                    settingsMenuRow(
                        icon: "cpu",
                        title: "Runner",
                        value: selectedRunner?.displayName ?? "Choose runner"
                    ) {
                        ForEach(availableRunners.filter(\.installed)) { runner in
                            Button {
                                pickedRunner = runner.canonicalId
                                pickedModel = preferredModel(in: runner)?.id ?? ""
                            } label: {
                                let label = runner.ready ? runner.displayName : "\(runner.displayName) · needs attention"
                                if runner.canonicalId == RegisteredRunner.canonical(pickedRunner) {
                                    Label(label, systemImage: "checkmark")
                                } else {
                                    Text(label)
                                }
                            }
                        }
                    }

                    settingsMenuRow(
                        icon: "sparkles",
                        title: "Model",
                        value: selectedModel?.name ?? (pickedModel.isEmpty ? "Runner default" : pickedModel)
                    ) {
                        Button { pickedModel = "" } label: {
                            if pickedModel.isEmpty { Label("Runner default", systemImage: "checkmark") }
                            else { Text("Runner default") }
                        }
                        if selectedRunner?.models.isEmpty == false { Divider() }
                        ForEach(selectedRunner?.models ?? []) { model in
                            Button { pickedModel = model.id } label: {
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
                            if latestMCPPreference != nil {
                                Button("Use latest") { useLatestMCP() }
                            }
                            if yaverMcpOn || !pickedMCPServers.isEmpty {
                                Button("Clear all") {
                                    yaverMcpOn = false
                                    pickedMCPServers.removeAll()
                                    persistMCPSelection()
                                }
                            }
                        }
                        Text("Optional. No MCP is selected unless you choose one or tap Use latest.")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                        mcpToggle("Yaver MCP", selected: yaverMcpOn) {
                            yaverMcpOn.toggle()
                            persistMCPSelection()
                        }
                        ForEach(availableMCPServers, id: \.self) { name in
                            mcpToggle(name, selected: pickedMCPServers.contains(name)) {
                                if pickedMCPServers.contains(name) { pickedMCPServers.remove(name) }
                                else { pickedMCPServers.insert(name) }
                                persistMCPSelection()
                            }
                        }
                    }
                    .padding(22)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
                }
                .padding(40)
            }
            .navigationTitle("Task settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        showTaskSettings = false
                        promptFocused = true
                    }
                }
            }
        }
    }

    private func settingsMenuRow<Content: View>(
        icon: String,
        title: String,
        value: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 18) {
            Image(systemName: icon)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.blue)
                .frame(width: 44)
            Text(title).font(.system(size: 22, weight: .semibold))
            Spacer()
            Menu(content: content) {
                HStack(spacing: 8) {
                    Text(value).lineLimit(1)
                    Image(systemName: "chevron.down")
                }
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
                Text(title).font(.system(size: 18, weight: .medium))
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? .blue : .secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }

    private func preferredModel(in runner: AgentRunnerSummary) -> AgentRunnerModel? {
        runner.models.first(where: { $0.isDefault == true }) ?? runner.models.first
    }

    private var latestProject: ProjectSummary? {
        guard let boxId = runnerBoxId else { return nil }
        return store.lastProject(for: boxId, projects: availableProjects)
    }

    private var latestMCPPreference: MachineRegistry.MCPServersPref? {
        guard let boxId = runnerBoxId else { return nil }
        return store.lastMCPServersByDevice[boxId]
    }

    private func useLatestMCP() {
        guard let pref = latestMCPPreference else { return }
        yaverMcpOn = pref.includeYaverMcp ?? false
        pickedMCPServers = Set(pref.mcpServers ?? []).intersection(Set(availableMCPServers))
        mcpSelectionLoaded = true
    }

    private func persistMCPSelection() {
        mcpSelectionLoaded = true
        guard let boxId = runnerBoxId else { return }
        store.rememberMCPServers(
            Array(pickedMCPServers).sorted(), includeYaverMcp: yaverMcpOn, for: boxId
        )
    }

    private func loadPickerState() async {
        guard let boxId = runnerBoxId else { return }
        // Task scope is opt-in. Never silently inherit the last project's
        // absolute path or the last MCP grant into a new coding task.
        if !mcpSelectionLoaded {
            yaverMcpOn = false
            pickedMCPServers.removeAll()
        }
        mcpSelectionLoaded = true
        guard let client = store.runnerClient() else { return }
        async let projectRows: [ProjectSummary]? = try? client.listProjects()
        async let mcpRows: [McpServerSummary]? = try? client.listMCPServers()
        async let runnerRows: AgentRunnerList? = try? client.listRunners()
        let (projectList, serverList, runnerList) = await (projectRows, mcpRows, runnerRows)
        if let list = projectList {
            availableProjects = list
            // Explicit "start a vibe in THIS project" wins over the remembered
            // one (2026-08-13) — comes from a project's preview dead-end.
            if !projectSelectionLoaded, let name = initialProjectName {
                pickedProjectPath = availableProjects.first(where: { $0.name == name })?.path
                if let path = pickedProjectPath, let proj = availableProjects.first(where: { $0.path == path }) {
                    store.rememberProject(proj, for: boxId)
                }
            } else if !projectSelectionLoaded {
                // No explicit project means exactly that. A previous task's
                // scope must never become this task's implicit filesystem
                // authority.
                pickedProjectPath = nil
            }
            projectSelectionLoaded = true
        }
        if let servers = serverList {
            availableMCPServers = servers.map(\.name)
            let known = Set(availableMCPServers)
            pickedMCPServers = pickedMCPServers.intersection(known)
        }
        if let runnerList {
            availableRunners = runnerList.runners.filter { $0.installed }
            if !runnerSelectionLoaded {
                let preferred = store.primaryRunnerByDevice[boxId]
                    ?? runnerList.default
                    ?? availableRunners.first(where: \.isDefault)?.id
                    ?? availableRunners.first?.id
                    ?? ""
                pickedRunner = RegisteredRunner.canonical(preferred)
                if let runner = selectedRunner { pickedModel = preferredModel(in: runner)?.id ?? "" }
                runnerSelectionLoaded = true
            } else if selectedRunner == nil, let first = availableRunners.first {
                pickedRunner = first.canonicalId
                pickedModel = preferredModel(in: first)?.id ?? ""
            } else if let runner = selectedRunner,
                      !pickedModel.isEmpty,
                      !runner.models.contains(where: { $0.id == pickedModel }) {
                pickedModel = preferredModel(in: runner)?.id ?? ""
            }
        }
    }

    private func create() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !creating else { return }
        creating = true
        error = nil
        Task {
            do {
                // Typing can be quicker than both /projects and /mcp finish.
                // Re-hydrate before POST so the one-step UI still respects the
                // same remembered project/MCP context as mobile and web.
                await loadPickerState()
                guard let client = store.runnerClient() else {
                    let plan = store.taskRuntimePlan()
                    throw AgentError(message: plan.kind == .boxlessUnavailable
                        ? "No task runner is connected. Remote runner tasks remain available; boxless Git+coding is not configured on this TV yet."
                        : store.machineSplitActive
                        ? "Your AI runner machine needs the relay to be reachable from this TV."
                        : "No machine selected")
                }
                let task = try await client.createTask(
                    title: text,
                    description: text,
                    workDir: pickedProjectPath ?? "",
                    projectName: pickedProjectPath.flatMap { path in
                        availableProjects.first(where: { $0.path == path })?.name
                    } ?? "",
                    runner: pickedRunner,
                    model: pickedModel,
                    mode: "",
                    // Chat → New vibe is the TV's Deep Audit doorway. Runner,
                    // model and scope are optional per-task overrides behind
                    // the ellipsis; this action always requests the grounded
                    // explain-first audit contract from the agent.
                    askMode: true,
                    mcpServers: Array(pickedMCPServers).sorted(),
                    includeYaverMcp: yaverMcpOn
                )
                onCreated(task)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                // POST failures stay recoverable without resurrecting the old
                // Start page: put the user straight back in the keyboard with
                // their text intact.
                promptFocused = true
            }
            creating = false
        }
    }
}
