import SwiftUI

/// Native Yaver Code for Apple surfaces when no runner box is selected.
///
/// This is intentionally a chat/audit surface. It never presents a fake
/// terminal and never claims to edit Git or run a build without a runner.
struct BoxlessCodeView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var answer = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case prompt, send }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Label("Yaver Code · boxless", systemImage: "sparkles")
                    .font(.system(size: 28, weight: .bold))
                Spacer()
                Button("Done") { dismiss() }
            }
            Text("DeepSeek V4 Flash chat and deep audit without a remote box. Approve DeepSeek access from the Yaver iPhone app or use the selected machine's vault. Git edits, shell commands, builds, simulators, rendering, and deploys still require a remote runner.")
                .font(.system(size: 17)).foregroundStyle(.secondary)
                .frame(maxWidth: 900, alignment: .leading)
            Label(
                BoxlessDeepSeekKeyStore.load().isEmpty
                    ? "No DeepSeek credential is available on this Apple TV yet."
                    : "DeepSeek credential is available from secure device storage.",
                systemImage: BoxlessDeepSeekKeyStore.load().isEmpty ? "iphone.and.arrow.forward" : "checkmark.shield"
            )
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("boxless.credential-status")
            // tvOS delivers Siri Remote dictation to the focused native
            // TextField. The multiline axis variant is not a reliable
            // dictation target on tvOS, so keep input single-line and let the
            // answer area carry the multiline content.
            TextField("Ask Yaver Code for a deep audit or explanation…", text: $prompt)
                .font(.system(size: 20))
                .frame(minHeight: 100, maxHeight: 150)
                .padding(8)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .focused($focus, equals: .prompt)
                .accessibilityIdentifier("boxless.prompt")
            HStack {
                Button(busy ? "Thinking…" : "Deep audit / ask") { send(mode: "deep-audit") }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .focused($focus, equals: .send)
                    .accessibilityIdentifier("boxless.send")
                if let error { Text(error).foregroundStyle(.orange).lineLimit(2) }
            }
            ScrollView {
                Text(answer.isEmpty ? "Your Yaver Code answer will appear here." : answer)
                    .font(.system(size: 18))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(18)
            .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
        }
        .padding(48)
        .frame(maxWidth: 1100, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black)
        .defaultFocus($focus, .prompt)
        .onAppear {
            // The Siri Remote microphone has no public button callback; it
            // only dictates into the currently focused text field.
            DispatchQueue.main.async { focus = .prompt }
        }
    }

    private func send(mode: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        busy = true; error = nil; answer = ""
        Task {
            do {
                let key = BoxlessDeepSeekKeyStore.load()
                guard !key.isEmpty else {
                    throw BoxlessDeepSeekError.missingKey
                }
                let result = try await BoxlessDeepSeekClient(apiKey: key).answer(prompt: text, mode: mode)
                await MainActor.run { answer = result; busy = false }
            } catch {
                await MainActor.run { self.error = error.localizedDescription; busy = false }
            }
        }
    }
}
