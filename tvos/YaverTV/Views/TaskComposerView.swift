// TaskComposerView.swift — START a vibe from the couch (POST /tasks).
//
// This closes the gap that made the TV a monitor instead of a surface: the
// client had createTask (AgentClient.swift) since 2026-08-03 and no view ever
// called it, so the TV could watch work happen and never start any. The
// composer mirrors the web dispatch funnel's body — empty runner/model lets
// the agent apply the account's per-device primary, exactly like the phone —
// plus the opencode mode/goal/askMode fields so a TV-started task is
// indistinguishable from one started in the dashboard.
//
// Project + MCP pickers reuse VibeTurnPanel's Convex-remembered pattern
// (defaultRuntimeProjectByDevice / mcpServersByDevice via YaverStore), so a
// project picked on the phone shows up pre-selected on the TV.

import SwiftUI
import UIKit

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
    @State private var keyboardActivation = 0
    // Project/MCP picker state (runner box /projects, same as mobile/web).
    // Both are optional task context: a prompt can be sent immediately with
    // the per-device default runner and no project/MCP setup ceremony.
    @State private var availableProjects: [ProjectSummary] = []
    @State private var pickedProjectPath: String?
    @State private var availableMCPServers: [String] = []
    @State private var pickedMCPServers: Set<String> = []
    @State private var yaverMcpOn = true
    private var runnerBoxId: String? { store.runnerBox()?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            header

            // New vibe is a one-action surface: selecting it opens the system
            // keyboard immediately and Done submits. A second "Start vibe"
            // page made the couch flow Select → type → dismiss → move → Select,
            // and duplicated defaults that already live in Settings.
            AutoSubmittingVibeField(
                text: $prompt,
                activation: keyboardActivation,
                enabled: !creating,
                onSubmit: create
            )
            .frame(height: 66)

            if creating {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Starting Deep Audit…")
                        .font(.system(size: 17, weight: .semibold))
                }
            } else {
                Text("Dictate or type, then press Done. Your remembered project, runner, and MCP settings are used automatically.")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
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
        .onAppear { keyboardActivation += 1 }
    }

    private var header: some View {
        HStack {
            Image(systemName: "wand.and.stars").font(.system(size: 26)).foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 3) {
                Text("New vibe").font(.system(size: 30, weight: .bold))
                Text("Deep Audit").font(.system(size: 15, weight: .semibold)).foregroundStyle(.blue)
            }
            Spacer()
        }
    }

    // Project/MCP values are hydrated silently from the shared settings rows.

    private var projectChip: some View {
        Menu {
            Button {
                pickedProjectPath = nil
            } label: {
                if pickedProjectPath == nil {
                    Label("No project (optional)", systemImage: "checkmark")
                } else {
                    Text("No project (optional)")
                }
            }
            if !availableProjects.isEmpty { Divider() }
            ForEach(availableProjects) { p in
                Button {
                    pickedProjectPath = p.path
                    if let boxId = runnerBoxId {
                        store.rememberProject(p, for: boxId)
                    }
                } label: {
                    if p.path == pickedProjectPath {
                        Label(p.name, systemImage: "checkmark")
                    } else {
                        Text(p.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                Text(currentProjectLabel)
            }
            .font(.system(size: 15, weight: .semibold))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    private var currentProjectLabel: String {
        if let path = pickedProjectPath {
            return availableProjects.first(where: { $0.path == path })?.name
                ?? path.split(separator: "/").last.map(String.init)
                ?? path
        }
        return "No project · optional ▾"
    }

    private var mcpChip: some View {
        Menu {
            Button {
                yaverMcpOn.toggle()
                persistMCP()
            } label: {
                if yaverMcpOn {
                    Label("yaver (on)", systemImage: "checkmark")
                } else {
                    Text("yaver (off)")
                }
            }
            if !availableMCPServers.isEmpty {
                Divider()
                ForEach(availableMCPServers, id: \.self) { name in
                    Button {
                        if pickedMCPServers.contains(name) {
                            pickedMCPServers.remove(name)
                        } else {
                            pickedMCPServers.insert(name)
                        }
                        persistMCP()
                    } label: {
                        if pickedMCPServers.contains(name) {
                            Label(name, systemImage: "checkmark")
                        } else {
                            Text(name)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "platter.2.filled.ipad")
                Text(yaverMcpOn ? "yaver" : "yaver (off)")
                if !pickedMCPServers.isEmpty {
                    Text("· \(pickedMCPServers.count) MCP")
                }
            }
            .font(.system(size: 15, weight: .semibold))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    private func persistMCP() {
        guard let boxId = runnerBoxId else { return }
        store.rememberMCPServers(Array(pickedMCPServers), includeYaverMcp: yaverMcpOn, for: boxId)
    }

    private func loadPickerState() async {
        guard let boxId = runnerBoxId else { return }
        if let mcpPref = store.lastMCPServersByDevice[boxId] {
            yaverMcpOn = mcpPref.includeYaverMcp ?? true
            pickedMCPServers = Set(mcpPref.mcpServers ?? [])
        }
        guard let client = store.runnerClient() else { return }
        if let list = try? await client.listProjects() {
            availableProjects = list
            // Explicit "start a vibe in THIS project" wins over the remembered
            // one (2026-08-13) — comes from a project's preview dead-end.
            if let name = initialProjectName {
                pickedProjectPath = availableProjects.first(where: { $0.name == name })?.path
                if let path = pickedProjectPath, let proj = availableProjects.first(where: { $0.path == path }) {
                    store.rememberProject(proj, for: boxId)
                }
            } else {
                // No explicit project: restore the cross-surface last choice,
                // but never fall back to the first discovered repo. Discovery
                // order is inventory, not user intent.
                pickedProjectPath = store.lastProject(for: boxId, projects: availableProjects)?.path
            }
        }
        if let servers = try? await client.listMCPServers() {
            availableMCPServers = servers.map(\.name)
            let known = Set(availableMCPServers)
            pickedMCPServers = pickedMCPServers.intersection(known)
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
                    throw AgentError(message: store.machineSplitActive
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
                    mode: "",
                    // Chat → New vibe is the TV's Deep Audit doorway. There is
                    // no per-run toggle on this quick path: Settings owns
                    // defaults, while this action always requests the grounded
                    // explain-first audit contract from the agent.
                    askMode: true,
                    mcpServers: Array(pickedMCPServers),
                    includeYaverMcp: yaverMcpOn
                )
                onCreated(task)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                // POST failures stay recoverable without resurrecting the old
                // Start page: put the user straight back in the keyboard with
                // their text intact.
                keyboardActivation += 1
            }
            creating = false
        }
    }
}

/// A tvOS text field that enters editing immediately when presented.
///
/// SwiftUI FocusState only highlights a tvOS TextField; the user still has to
/// press Select before the system keyboard appears. `becomeFirstResponder()`
/// is the missing product action here. The retry is bounded because a newly
/// presented sheet needs a few run-loop turns before its field has a window.
private struct AutoSubmittingVibeField: UIViewRepresentable {
    @Binding var text: String
    let activation: Int
    let enabled: Bool
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField(frame: .zero)
        field.delegate = context.coordinator
        field.placeholder = "What should I deeply audit?"
        field.font = .systemFont(ofSize: 22)
        field.textColor = .label
        field.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        field.layer.cornerRadius = 14
        field.layer.masksToBounds = true
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 20, height: 1))
        field.leftViewMode = .always
        field.returnKeyType = .send
        field.accessibilityIdentifier = "chat.prompt"
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        context.coordinator.requestActivation(for: field, value: activation)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        field.isEnabled = enabled
        context.coordinator.requestActivation(for: field, value: activation)
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: AutoSubmittingVibeField
        private var handledActivation = Int.min

        init(_ parent: AutoSubmittingVibeField) {
            self.parent = parent
        }

        @objc func changed(_ field: UITextField) {
            parent.text = field.text ?? ""
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.text = textField.text ?? ""
            guard !(textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return false
            }
            textField.resignFirstResponder()
            DispatchQueue.main.async { self.parent.onSubmit() }
            return false
        }

        func requestActivation(for field: UITextField, value: Int) {
            guard value != handledActivation else { return }
            handledActivation = value
            activate(field, remainingAttempts: 8)
        }

        private func activate(_ field: UITextField, remainingAttempts: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self, weak field] in
                guard let self, let field, self.parent.enabled else { return }
                if field.window != nil {
                    field.becomeFirstResponder()
                } else if remainingAttempts > 0 {
                    self.activate(field, remainingAttempts: remainingAttempts - 1)
                }
            }
        }
    }
}
