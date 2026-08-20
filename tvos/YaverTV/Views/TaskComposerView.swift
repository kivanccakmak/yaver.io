// TaskComposerView.swift — keyboard-only New vibe handoff.
//
// New vibe is not a Yaver form. Selecting it opens the native tvOS keyboard,
// which is mirrored by iPhone Continuity Keyboard. The user types or dictates,
// presses the blue tick once, and the next visible Yaver surface is the exact
// task conversation returned by POST /tasks. Keep this view visually empty:
// disabling or replacing its responder while the POST runs closes the system
// keyboard and exposes an unwanted intermediate "Starting session" widget.

import SwiftUI

struct TaskComposerView: View {
    @EnvironmentObject private var store: YaverStore
    @Environment(\.dismiss) private var dismiss

    private let initialProjectName: String?
    private let dismissAfterCreate: Bool
    private let onCreated: (TaskSummary) -> Void

    init(
        initialProjectName: String? = nil,
        dismissAfterCreate: Bool = true,
        onCreated: @escaping (TaskSummary) -> Void = { _ in }
    ) {
        self.initialProjectName = initialProjectName
        self.dismissAfterCreate = dismissAfterCreate
        self.onCreated = onCreated
    }

    @State private var prompt = ""
    @State private var creating = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool
    @State private var editingRequest = 0

    @State private var availableProjects: [ProjectSummary] = []
    @State private var pickedProjectPath: String?
    @State private var availableRunners: [AgentRunnerSummary] = []
    @State private var pickedRunner = ""
    @State private var pickedModel = ""
    @State private var defaultsLoaded = false

    private var runnerBoxId: String? { store.runnerBox()?.id }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // UIKit needs a real attached UITextField for Siri Remote and
            // iPhone Continuity dictation. It deliberately has no visible app
            // chrome: the native system keyboard is the complete New vibe UI.
            YaverDictationField(
                text: $prompt,
                editingRequestID: editingRequest,
                onSubmit: { create() },
                onEndEditing: { create() },
                autoSubmitBatchInput: true,
                textColor: .clear,
                tint: .clear,
                fieldBackgroundColor: .clear,
                accessibilityIdentifier: "chat.prompt"
            )
            .focused($promptFocused)
            .frame(width: 320, height: 60)
            .focusEffectDisabled()
        }
        .task { await loadDispatchDefaults() }
        .onAppear {
            InputStateReporter.shared.route = "task-composer"
            DispatchQueue.main.async {
                promptFocused = true
                editingRequest += 1
            }
        }
        .defaultFocus($promptFocused, true)
        .alert("Couldn’t start session", isPresented: errorPresented) {
            Button("Try again") { create() }
            Button("Cancel", role: .cancel) { dismiss() }
        } message: {
            Text(error ?? "The task was not created.")
        }
        #if os(tvOS)
        .onExitCommand { dismiss() }
        #endif
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { error != nil },
            set: { if !$0 { error = nil } }
        )
    }

    private var selectedRunner: AgentRunnerSummary? {
        availableRunners.first {
            $0.canonicalId == RegisteredRunner.canonical(pickedRunner)
        }
    }

    private func preferredModel(in runner: AgentRunnerSummary) -> AgentRunnerModel? {
        runner.models.first(where: { $0.isDefault == true }) ?? runner.models.first
    }

    private func loadDispatchDefaults() async {
        guard !defaultsLoaded, let boxId = runnerBoxId,
              let client = store.runnerClient() else { return }

        async let projectRows: [ProjectSummary]? = try? client.listProjects()
        async let runnerRows: AgentRunnerList? = try? client.listRunners()
        let (projectList, runnerList) = await (projectRows, runnerRows)

        if let projectList {
            availableProjects = projectList
            // New vibe has no hidden filesystem authority. Only a project
            // route which explicitly supplied a name can scope the task.
            if let initialProjectName {
                pickedProjectPath = projectList.first {
                    $0.name == initialProjectName
                }?.path
            }
        }

        if let runnerList {
            availableRunners = runnerList.runners.filter(\.installed)
            let preferred = store.primaryRunnerByDevice[boxId]
                ?? runnerList.default
                ?? availableRunners.first(where: \.isDefault)?.id
                ?? availableRunners.first?.id
                ?? ""
            pickedRunner = RegisteredRunner.canonical(preferred)
            if let runner = selectedRunner {
                pickedModel = preferredModel(in: runner)?.id ?? ""
            }
        }
        defaultsLoaded = true
    }

    private func create() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !creating else { return }
        creating = true
        error = nil

        Task {
            do {
                await loadDispatchDefaults()
                guard let client = store.runnerClient() else {
                    let plan = store.taskRuntimePlan()
                    throw AgentError(message: plan.kind == .boxlessUnavailable
                        ? "No task runner is connected. Boxless Git+coding is not configured on this TV yet."
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
                    askMode: true,
                    mcpServers: [],
                    includeYaverMcp: false
                )

                // Navigation replaces this keyboard host atomically with the
                // returned conversation. Its dismantle closes the system
                // keyboard; there is no intermediate Yaver screen.
                onCreated(task)
                if dismissAfterCreate { dismiss() }
            } catch {
                self.error = error.localizedDescription
            }
            creating = false
        }
    }
}
