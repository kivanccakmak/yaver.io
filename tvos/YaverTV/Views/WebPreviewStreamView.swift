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

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let frame {
                Image(uiImage: frame).resizable().aspectRatio(contentMode: .fit).padding(24)
            } else if let error {
                VStack(spacing: 16) {
                    Image(systemName: "globe.badge.chevron.backward").font(.system(size: 56)).foregroundStyle(.secondary)
                    Text("Preview unavailable").font(.title2)
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 680)
                    Button("Try again") { restart() }
                }
            } else {
                VStack(spacing: 14) { ProgressView().scaleEffect(1.5); Text(status).foregroundStyle(.secondary) }
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
        .onDisappear {
            pollTask?.cancel()
            logTask?.cancel()
            Task { await store.client()?.stopWebPreview(project: project.name) }
        }
    }

    private var logPanel: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Agent activity", systemImage: "text.alignleft")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
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
        started = true
        logLines = []
        pollTask?.cancel()
        logTask?.cancel()
        pollTask = Task { await run() }
    }

    private func run() async {
        guard let client = store.client() else { error = "No machine selected"; return }
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
                Task { @MainActor in appendLog(line) }
            } onError: { message in
                Task { @MainActor in appendLog("[stream] \(message)") }
            }
            await stream.value
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
