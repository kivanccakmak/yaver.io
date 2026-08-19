// VisionSessionView.swift — compact prompt surface for an existing runner
// session. It uses the shared SessionClient but keeps the UI visionOS-native
// and dependency-light.

import SwiftUI

struct VisionSessionView: View {
    @EnvironmentObject var store: YaverStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var prompt = ""
    @State private var pane = ""
    @State private var sessionName = ""
    @State private var runnerName = ""
    @State private var sessions: [RunnerSession] = []
    @State private var selectedSession = ""
    @State private var awaitingChoice = false
    @State private var options: [String] = []
    @State private var loading = false
    @State private var error: String?
    @StateObject private var dictation = DictationSession()
    /// What the user had typed before the mic opened, so a transcript APPENDS
    /// rather than overwriting work they already did by hand.
    @State private var typedBeforeDictation = ""

    private var sessionClient: SessionClient? {
        guard let box = store.selectedBox else { return nil }
        return SessionClient(token: store.token, box: box)
    }

    private var agentClient: AgentClient? {
        store.client()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            sessionPicker
            paneView

            if awaitingChoice {
                choices
            } else {
                composer
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.footnote)
            }
        }
        .padding(28)
        .frame(minWidth: 760, minHeight: 620)
        .glassBackgroundEffect()
        .task(id: store.selectedBox?.id) { await loadSessions() }
        .task(id: selectedSession) { await streamSelectedSession() }
        .onDisappear { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { dictation.stop() }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Live Session")
                    .font(.largeTitle.bold())
                Text(headerSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if loading {
                ProgressView()
            }
            Button {
                dismiss()
            } label: {
                Label("Close", systemImage: "xmark")
            }
        }
    }

    private var paneView: some View {
        ScrollView {
            Text(pane.isEmpty ? emptyPaneText : pane)
                .font(.system(size: 15, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                TextField("Ask the active coding session...", text: $prompt, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await sendPrompt() } }

                // DICTATION. In a headset the alternative is the floating
                // virtual keyboard, for the longest strings Yaver asks anyone
                // to type — so this is the primary input here, not a nicety.
                //
                // Shown ONLY when this headset can transcribe without sending
                // audio anywhere (canDictatePrivately). An offered control that
                // will refuse is worse than no control: it teaches the user the
                // product is unreliable rather than that their language pack is
                // missing. When it is hidden, typing still works exactly as before.
                if dictation.canDictatePrivately {
                    Button {
                        Task { await toggleDictation() }
                    } label: {
                        Label(dictation.listening ? "Stop" : "Speak",
                              systemImage: dictation.listening ? "stop.circle.fill" : "mic.fill")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.bordered)
                    .tint(dictation.listening ? .red : nil)
                    .accessibilityLabel(dictation.listening ? "Stop dictation" : "Dictate a prompt")
                    .disabled(loading || selectedSession.isEmpty)
                } else if !selectedSession.isEmpty {
                    Label("On-device dictation is unavailable for this language on this headset. Download the language in Settings › General › Keyboard › Dictation, or use the virtual keyboard.", systemImage: "mic.slash")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Button {
                    Task { await sendPrompt() }
                } label: {
                    Label("Send", systemImage: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loading || selectedSession.isEmpty)
            }

            // Narrate the wait. A mic that is listening with no visible state is
            // the same defect as a spinner with no elapsed time.
            if dictation.listening {
                Label("Listening — on-device only, audio never leaves this headset",
                      systemImage: "waveform")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let speechError = dictation.error {
                Text(speechError)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        // The transcript APPENDS to whatever was typed by hand. Assigning it
        // straight to `prompt` would delete a half-written prompt the moment the
        // user reached for the mic to finish it — destroying work is a far worse
        // failure than a clumsy concatenation.
        .onChange(of: dictation.transcript) { _, spoken in
            guard dictation.listening || !spoken.isEmpty else { return }
            let base = typedBeforeDictation.trimmingCharacters(in: .whitespacesAndNewlines)
            prompt = base.isEmpty ? spoken : base + " " + spoken
        }
    }

    /// Start/stop dictation, moving the transcript into the prompt field.
    ///
    /// The transcript REPLACES nothing the user typed by hand: it appends, so a
    /// half-typed prompt finished by voice is not silently destroyed.
    private func toggleDictation() async {
        if dictation.listening {
            dictation.stop()
            return
        }
        typedBeforeDictation = prompt
        await dictation.start()
    }

    private var sessionPicker: some View {
        HStack(spacing: 12) {
            Picker("Session", selection: $selectedSession) {
                if sessions.isEmpty {
                    Text("No sessions").tag("")
                } else {
                    ForEach(sessions) { session in
                        Text(session.label).tag(session.name)
                    }
                }
            }
            .pickerStyle(.menu)
            .disabled(sessions.isEmpty || loading)

            Button {
                Task { await loadSessions() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(loading)
        }
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The session is waiting for a choice.")
                .foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                        Button {
                            Task { await sendChoice(String(index + 1)) }
                        } label: {
                            Text(option)
                                .lineLimit(2)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(loading)
                    }
                }
            }
        }
    }

    private var headerSubtitle: String {
        if !sessionName.isEmpty {
            return [sessionName, runnerName].filter { !$0.isEmpty }.joined(separator: " / ")
        }
        if let selected = sessions.first(where: { $0.name == selectedSession }) {
            return selected.label
        }
        return store.selectedBox.map { "on \($0.name)" } ?? "No machine selected"
    }

    private var emptyPaneText: String {
        if selectedSession.isEmpty {
            return "Select a live runner session on the selected machine."
        }
        return "Send a prompt to \(selectedSession)."
    }

    private func loadSessions() async {
        error = nil
        do {
            guard let agentClient else { throw AgentError(message: "No machine selected") }
            let result = try await agentClient.runnerSessions()
            sessions = result.sessions ?? []
            if selectedSession.isEmpty || !sessions.contains(where: { $0.name == selectedSession }) {
                selectedSession = sessions.first?.name ?? ""
            }
        } catch {
            sessions = []
            selectedSession = ""
            if store.handleAuthenticationFailure(error) { return }
            self.error = error.localizedDescription
        }
    }

    private func sendPrompt() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard !selectedSession.isEmpty else {
            error = "Select a live runner session first."
            return
        }
        prompt = ""
        loading = true
        error = nil
        defer { loading = false }
        do {
            guard let sessionClient else { throw AgentError(message: "No machine selected") }
            apply(try await sessionClient.sendText(text, session: selectedSession, surfaceId: "vision"))
        } catch {
            if store.handleAuthenticationFailure(error) { return }
            self.error = error.localizedDescription
        }
    }

    private func streamSelectedSession() async {
        guard !selectedSession.isEmpty, let agentClient else { return }
        let watched = selectedSession
        let stream = await agentClient.subscribeTmuxPane(
            session: watched,
            onPane: { frame in
                Task { @MainActor in
                    guard self.selectedSession == frame.sessionName else { return }
                    self.sessionName = frame.sessionName
                    self.runnerName = frame.agent ?? self.runnerName
                    self.pane = frame.preview.map(redactHomePaths) ?? self.pane
                    self.awaitingChoice = frame.status == "awaiting-input"
                    self.options = (frame.options ?? []).map(redactHomePaths)
                    if frame.status == "dead" {
                        self.error = frame.statusReason ?? "The coding session closed."
                    }
                }
            },
            onDone: { reason in
                Task { @MainActor in
                    self.error = reason ?? "The coding session closed."
                }
            },
            onEnd: { kind, reason in
                guard case .interrupted = kind else { return }
                Task { @MainActor in
                    self.error = reason ?? "The live session stream was interrupted."
                }
            }
        )
        await withTaskCancellationHandler {
            await stream.value
        } onCancel: {
            stream.cancel()
        }
    }

    private func sendChoice(_ choice: String) async {
        guard !selectedSession.isEmpty else {
            error = "Select a live runner session first."
            return
        }
        loading = true
        error = nil
        defer { loading = false }
        do {
            guard let sessionClient else { throw AgentError(message: "No machine selected") }
            apply(try await sessionClient.sendChoice(choice, session: selectedSession))
        } catch {
            if store.handleAuthenticationFailure(error) { return }
            self.error = error.localizedDescription
        }
    }

    private func apply(_ result: SessionTurnResult) {
        if let session = result.session { sessionName = session }
        if let runner = result.runner { runnerName = runner }
        if let pane = result.pane { self.pane = pane }
        awaitingChoice = result.awaitingChoice == true
        options = result.options ?? []
        if let err = result.error, result.ok == false {
            error = err
        }
    }
}
