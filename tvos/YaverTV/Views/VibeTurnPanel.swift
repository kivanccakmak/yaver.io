// VibeTurnPanel.swift — the vibe loop ON the preview screen.
//
// This is what makes the TV a vibing surface instead of a monitor: the same
// screen that streams the app also takes the next prompt. Web gets this with
// a chat pane beside an iframe (RuntimeLabView); the TV gets a focusable
// overlay — press Vibe, dictate or type into the tvOS keyboard (Siri Remote
// dictation types into a TextField for free), and the turn goes to the
// RUNNER box while the preview keeps polling underneath. HMR lands in the
// frame stream on its own; nothing re-mounts, nothing blanks.
//
// Turn plumbing is the existing SessionClient (/runner/session/turn) — the
// endpoint that drives the session the user already has running, with the
// same pane + options + awaitingChoice contract SessionView renders. Options
// come back as focusable buttons, so "runner asks, user picks" works from
// the couch without ever leaving the preview.
//
// Role rule: the turn client is built from store.runnerBox() — NEVER the
// selected box. In a runner/render split the selected box may be the render
// machine, and a prompt sent there lands on a box with no runner sessions.

import SwiftUI

struct VibeTurnPanel: View {
    @EnvironmentObject var store: YaverStore

    /// Names the app being vibed so the panel can say where the turn went.
    let projectName: String

    @State private var expanded = false
    @State private var prompt = ""
    @State private var sending = false
    @State private var turn: SessionTurnResult?
    @State private var turnError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let turnError {
                Text(turnError)
                    .font(.system(size: 15))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }

            if let turn {
                turnStatus(turn)
            }

            if expanded {
                HStack(spacing: 12) {
                    TextField("What should change?", text: $prompt)
                        .textFieldStyle(.plain)
                        .font(.system(size: 20))
                        .frame(maxWidth: 700)
                        .onSubmit { send() }
                    Button(sending ? "Sending…" : "Send") { send() }
                        .disabled(sending || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Close") { expanded = false }
                }
            } else {
                Button {
                    expanded = true
                } label: {
                    Label(turn == nil ? "Vibe — ask for a change" : "Ask for another change",
                          systemImage: "wand.and.stars")
                        .font(.system(size: 17, weight: .semibold))
                }
            }
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    /// The turn's life, narrated in place: what was sent, what the runner is
    /// showing, and — when it asks — the choices as focusable buttons.
    @ViewBuilder
    private func turnStatus(_ turn: SessionTurnResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if sending {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Working on \(projectName)…").foregroundStyle(.secondary)
                }
                .font(.system(size: 16))
            }
            if let pane = turn.pane, !pane.isEmpty {
                // The last few pane lines, home-paths redacted — a TV is a
                // shared-room surface; never print a username on it.
                Text(redactHomePaths(paneTail(pane)))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: 900, alignment: .leading)
            }
            if turn.awaitingChoice == true, let options = turn.options, !options.isEmpty {
                Text("The runner is asking:")
                    .font(.system(size: 15, weight: .semibold))
                HStack(spacing: 10) {
                    ForEach(options.prefix(4), id: \.self) { option in
                        Button(option) { choose(option) }
                            .font(.system(size: 15))
                            .disabled(sending)
                    }
                }
            }
        }
    }

    private func paneTail(_ pane: String, lines: Int = 3) -> String {
        pane.split(separator: "\n", omittingEmptySubsequences: true)
            .suffix(lines)
            .joined(separator: "\n")
    }

    private func client() -> SessionClient? {
        guard store.isAuthenticated, let box = store.runnerBox() else { return nil }
        return SessionClient(token: store.token, box: box)
    }

    private func send() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let client = client() else {
            turnError = store.machineSplitActive
                ? "Your AI machine needs the relay to be reachable from this TV."
                : "No machine selected"
            return
        }
        sending = true
        turnError = nil
        prompt = ""
        Task {
            do {
                let result = try await client.sendText(text, session: nil)
                await MainActor.run {
                    sending = false
                    turn = result
                    if result.ok == false, let err = result.error, !err.isEmpty {
                        turnError = err
                    }
                }
            } catch {
                await MainActor.run {
                    sending = false
                    turnError = error.localizedDescription
                }
            }
        }
    }

    private func choose(_ option: String) {
        guard let client = client() else { return }
        sending = true
        turnError = nil
        Task {
            do {
                let result = try await client.sendChoice(option, session: turn?.session)
                await MainActor.run {
                    sending = false
                    turn = result
                }
            } catch {
                await MainActor.run {
                    sending = false
                    turnError = error.localizedDescription
                }
            }
        }
    }
}
