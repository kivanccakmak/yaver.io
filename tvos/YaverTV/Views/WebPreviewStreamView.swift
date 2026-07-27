// WebPreviewStreamView.swift — render a web project on the TV as a pixel stream.
//
// tvOS has no WebKit, so a web app can't run in-process. The box captures it
// headless at the chosen viewport (phone/tablet/desktop) and the TV polls the
// frames. A Rebuild button re-triggers the box's reload and the stream keeps
// flowing — the vibe loop, lean-back: watch → tweak (on your machine) → rebuild
// → watch again, on the big screen.

import SwiftUI
import UIKit

struct WebPreviewStreamView: View {
    @EnvironmentObject var store: YaverStore
    let project: ProjectSummary
    let form: PreviewForm

    @State private var frame: UIImage?
    @State private var status = "Starting preview…"
    @State private var error: String?
    @State private var started = false
    @State private var pollTask: Task<Void, Never>?
    @State private var logTask: Task<Void, Never>?
    @State private var logLines: [String] = []
    @State private var rebuilding = false

    // The named capability gap, and the state of the fix we are running for it.
    @State private var gap: CapabilityGap?
    @State private var fixing = false
    @State private var fixStartedAt: Date?
    @State private var fixTask: Task<Void, Never>?
    @State private var fixTicker = Date()
    // Reattach bookkeeping for the /dev/events log stream.
    @State private var reattachAttempt = 0
    @State private var streamNotice: String?

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let frame {
                Image(uiImage: frame).resizable().aspectRatio(contentMode: .fit).padding(24)
            } else if let gap {
                // A NAMED gap outranks the raw error string: it says which tool
                // is missing and, when the box can install it, carries the
                // route. This is the panel whose absence made the phone show
                // "Waiting for the dev server to report its address…" over an
                // agent that had already said `flutter: executable file not
                // found in $PATH`.
                gapPanel(gap)
            } else if let error {
                VStack(spacing: 16) {
                    Image(systemName: "globe.badge.chevron.backward").font(.system(size: 56)).foregroundStyle(.secondary)
                    Text("Preview unavailable").font(.title2)
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 680)
                    if let remedy = FailureSignals.explainRelayDeny(error) {
                        // A relay device_mismatch can never self-heal. Saying
                        // "Try again" over it is the loop this sentence ends.
                        Text(remedy)
                            .font(.callout)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 680)
                    } else if let limit = FailureSignals.classifyRelayLimit(error) {
                        VStack(spacing: 6) {
                            Text(limit.title).font(.callout.bold()).foregroundStyle(.orange)
                            Text(limit.detail).font(.caption).foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: 680)
                    }
                    if FailureSignals.explainRelayDeny(error) == nil {
                        Button("Try again") { restart() }
                    }
                }
            } else {
                VStack(spacing: 14) {
                    ProgressView().scaleEffect(1.5)
                    Text(status).foregroundStyle(.secondary)
                }
            }

            VStack {
                HStack(spacing: 14) {
                    Label("\(project.name) · \(form.rawValue)", systemImage: form.icon)
                        .font(.system(size: 16, weight: .semibold))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                    Spacer()
                    Button { Task { await rebuild() } } label: {
                        Label(rebuilding ? "Rebuilding…" : "Rebuild", systemImage: "arrow.triangle.2.circlepath")
                            .font(.system(size: 16, weight: .semibold))
                    }
                    .disabled(rebuilding)
                }
                .padding(32)
                Spacer()
                if !logLines.isEmpty {
                    logPanel
                        .padding(.horizontal, 32)
                        .padding(.bottom, 30)
                }
            }
        }
        .onAppear { if !started { restart() } }
        .onReceive(ticker) { now in if fixing { fixTicker = now } }
        .onDisappear {
            pollTask?.cancel()
            logTask?.cancel()
            fixTask?.cancel()
            Task { await store.client()?.stopWebPreview(project: project.name) }
        }
    }

    /// The capability gap, rendered as what it is: a named missing tool, and
    /// either the button that installs it or the reason there is no button.
    @ViewBuilder
    private func gapPanel(_ gap: CapabilityGap) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "shippingbox.and.arrow.backward")
                .font(.system(size: 52))
                .foregroundStyle(.orange)
            Text(FailureSignals.gapTitle(gap))
                .font(.title2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 820)
            let body = FailureSignals.gapBody(gap)
            if !body.isEmpty {
                Text(body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 820)
            }

            if fixing {
                // Streaming the fix IS part of the fix: a multi-GB SDK behind a
                // silent spinner is indistinguishable from a hang, so the
                // elapsed time keeps moving even while the download is quiet.
                VStack(spacing: 8) {
                    ProgressView()
                    Text(fixElapsedLine())
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            } else if let label = FailureSignals.gapFixLabel(gap) {
                Button(label) { startFix(gap) }
                    .buttonStyle(.borderedProminent)
            } else {
                // No route. Say why, and do NOT offer a button that cannot
                // work — an install we know will fail teaches the user that
                // Yaver lies.
                Text(gap.constraint ?? "This machine cannot install it automatically.")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 820)
                Button("Try again") { restart() }
            }
        }
    }

    private func fixElapsedLine() -> String {
        guard let fixStartedAt else { return "starting…" }
        let elapsed = FailureSignals.shortDuration(fixTicker.timeIntervalSince(fixStartedAt) * 1000)
        let tail = logLines.last.map { " · \($0)" } ?? ""
        return "\(elapsed) elapsed\(tail)"
    }

    /// POST the gap's route, stream its output into the log panel, and — when
    /// the gap says the original operation should be retried — return the user
    /// to what they were doing instead of making them find the button again.
    private func startFix(_ gap: CapabilityGap) {
        guard let tool = FailureSignals.gapInstallTool(gap) else {
            error = gap.constraint ?? "This gap carries no install route."
            return
        }
        fixing = true
        fixStartedAt = Date()
        fixTicker = Date()
        appendLog("POST \(gap.fix?.path ?? "/install/\(tool)") …")
        fixTask?.cancel()
        fixTask = Task {
            guard let client = store.client() else {
                await MainActor.run { fixing = false; error = "No machine selected" }
                return
            }
            let started: AgentClient.InstallStarted
            do {
                started = try await client.installTool(tool)
            } catch {
                await MainActor.run {
                    fixing = false
                    self.error = "install \(tool) failed: \(error.localizedDescription)"
                }
                return
            }
            let streamName = started.stream ?? gap.fix?.stream ?? "install:\(tool)"
            await MainActor.run { appendLog("streaming /streams/\(streamName)") }
            let stream = await client.subscribeInstallStream(streamName) { line in
                Task { @MainActor in appendLog(line) }
            } onDone: { ok, err in
                Task { @MainActor in
                    fixing = false
                    if ok {
                        self.gap = nil
                        appendLog("\(tool) installed.")
                        if FailureSignals.gapRetriesAfterFix(gap) { restart() }
                    } else {
                        self.error = "\(tool) install failed: \(err ?? "unknown error")"
                    }
                }
            }
            await stream.value
        }
    }

    private var logPanel: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Agent activity", systemImage: "text.alignleft")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            if let streamNotice {
                Text(streamNotice)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(logLines.suffix(7).enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(color(for: line))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .frame(maxWidth: 960, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private func restart() {
        error = nil
        gap = nil
        streamNotice = nil
        reattachAttempt = 0
        started = true
        logLines = []
        pollTask?.cancel()
        logTask?.cancel()
        fixTask?.cancel()
        fixing = false
        pollTask = Task { await run() }
    }

    private func run() async {
        // Runner/render split: previews build + stream from the RENDER box.
        guard let client = store.renderClient() else {
            error = store.machineSplitActive
                ? "Your render machine needs the relay to be reachable from this TV."
                : "No machine selected"
            return
        }
        startLogStream(client)
        do {
            status = "Starting \(project.name)…"
            let dev = try await client.startDevServer(for: project)
            status = "Booting the browser lane…"
            let server = try await maybeStartExpoWebSibling(client)
            let target = captureTarget(dev: dev, server: server)
            status = "Capturing at \(form.rawValue) size…"
            try await client.startWebPreview(project: project.name, targetUrl: target,
                                              width: form.width, height: form.height)
            await poll(client)
        } catch let agentError as AgentError {
            // The 412 refusal carries the route; keep the sentence too, so a
            // gap-less failure still reads exactly as it always did.
            if let carried = agentError.gap {
                self.gap = carried
                appendLog(carried.summary)
            }
            self.error = agentError.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func startLogStream(_ client: AgentClient) {
        logTask?.cancel()
        logTask = Task {
            let stream = await client.subscribeDevEvents { ev in
                let line = ev.logLine ?? ev.message
                guard let line, !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                Task { @MainActor in
                    // Output flowing again IS the proof the reattach worked —
                    // clear the notice and reset the ladder so the next drop
                    // gets a full five attempts rather than starting exhausted.
                    if streamNotice != nil { streamNotice = nil; reattachAttempt = 0 }
                    appendLog(line)
                }
            } onGap: { carried in
                // A gap can also arrive mid-compile on the event bus, long
                // after /dev/start returned 200 — e.g. the framework CLI is
                // present but a platform SDK it shells out to is not.
                Task { @MainActor in
                    gap = carried
                    appendLog(carried.summary)
                }
            } onEnd: { kind, cause in
                Task { @MainActor in handleStreamEnd(kind, cause, client) }
            } onError: { message in
                Task { @MainActor in appendLog("[stream] \(message)") }
            }
            await stream.value
        }
    }

    /// The log panel used to freeze in silence when the tunnel dropped: the box
    /// kept compiling, the TV kept showing the last line it happened to get,
    /// and nothing said the difference. Name it, reattach on a bounded ladder,
    /// and stop with a sentence rather than a spinner.
    @MainActor
    private func handleStreamEnd(_ kind: FailureSignals.StreamEndKind, _ cause: String?, _ client: AgentClient) {
        let plan = FailureSignals.planStreamRecovery(end: kind, attempt: reattachAttempt, cause: cause)
        switch plan {
        case .idle:
            streamNotice = nil
        case let .reattach(_, delayMs, message):
            streamNotice = message
            reattachAttempt += 1
            logTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                if Task.isCancelled { return }
                await MainActor.run { startLogStream(client) }
            }
        case let .giveUp(message):
            streamNotice = message
        }
    }

    @MainActor
    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 50 {
            logLines.removeFirst(logLines.count - 50)
        }
    }

    private func poll(_ client: AgentClient) async {
        var lastHash = ""
        var misses = 0
        while !Task.isCancelled {
            do {
                let meta = try await client.previewSnapshot(project: project.name)
                if let hash = meta.hash, !hash.isEmpty, hash != lastHash {
                    let data = try await client.previewFrame(hash: hash)
                    if let img = UIImage(data: data) { frame = img; lastHash = hash; error = nil; misses = 0 }
                }
            } catch {
                misses += 1
                if misses >= 4 && frame == nil { self.error = error.localizedDescription }
            }
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
    }

    private func color(for line: String) -> Color {
        let lower = line.lowercased()
        if lower.contains("error") || lower.contains("failed") || lower.contains("exception") || lower.contains("cannot ") {
            return .red
        }
        if lower.contains("warning") || lower.contains("warn") || lower.contains("deprecated") || lower.contains("expected version") {
            return .orange
        }
        if lower.contains("ready") || lower.contains("listening") || lower.contains("bundled") || lower.contains("waiting on") {
            return .blue
        }
        return .secondary
    }

    /// URL for the headless browser running ON THE BOX, not for the Apple TV.
    ///
    /// `/dev-web/` is proxied through the local agent and intentionally needs no
    /// bearer header, so Chromium can load it directly. The previous URL mixed
    /// the TV-visible LAN host with the sibling process port and kept the
    /// `/dev-web/` path, which points at nothing.
    private func maybeStartExpoWebSibling(_ client: AgentClient) async throws -> AgentClient.WebPreviewStart? {
        let fw = (project.framework ?? "").lowercased()
        guard fw == "expo" || fw == "react-native" || fw == "reactnative" || fw == "rn" else {
            return nil
        }
        return try await client.startWebServer()
    }

    private func captureTarget(dev: AgentClient.DevStartResult, server: AgentClient.WebPreviewStart?) -> String {
        if let webUrl = server?.webUrl, webUrl.hasPrefix("/") {
            return "http://127.0.0.1:\(Backend.agentPort)\(webUrl)"
        }
        if let webUrl = server?.webUrl, webUrl.hasPrefix("http://") || webUrl.hasPrefix("https://") {
            return webUrl
        }
        if let url = dev.url, url.hasPrefix("http://") || url.hasPrefix("https://") {
            return url
        }
        if let port = dev.port ?? server?.port, port > 0 {
            return "http://127.0.0.1:\(port)"
        }
        return "http://127.0.0.1:3000"
    }

    private func rebuild() async {
        guard let client = store.client() else { return }
        rebuilding = true
        defer { rebuilding = false }
        do {
            _ = try await client.reload(mode: "dev", workDir: project.path)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
