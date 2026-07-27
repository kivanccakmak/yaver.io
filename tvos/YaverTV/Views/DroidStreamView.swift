// DroidStreamView.swift — watch a redroid / Android screen on the TV.
//
// The box runs redroid (containerized Android) for app testing; GET /droid/frame
// returns the live screen as PNG. AVPlayer can't play the agent's MJPEG streams
// (docs/yaver-tvos-surface.md §1.6), so — like the capture card — we poll frames
// and show the latest. ~2 fps is plenty to watch an app run from the couch.
//
// The TV is a viewer, not a controller here: /droid/input exists but a D-pad is
// a poor pointer, and the point of this screen is to WATCH the app under test on
// a big display. Control stays on the phone.

import SwiftUI
import UIKit

struct DroidStreamView: View {
    @EnvironmentObject var store: YaverStore

    @State private var frame: UIImage?
    @State private var error: String?
    /// True when the agent refused with auth.session.scope_denied — a
    /// deterministic 403 that no retry can clear. Renders the update route.
    @State private var scopeDenied = false
    @State private var pollTask: Task<Void, Never>?
    @State private var lastFrameAt: Date?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let frame {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .padding(24)
            } else if scopeDenied {
                // A scope 403 is deterministic — a Try again would 403 forever
                // (watched happen live 2026-07-27). Name the cause, offer the
                // one route that fixes it.
                VStack(spacing: 16) {
                    Image(systemName: "arrow.down.circle.dotted").font(.system(size: 56)).foregroundStyle(.orange)
                    Text("This box needs an agent update").font(.title2)
                    Text(FailureSignals.explainSessionScopeDenied())
                        .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 720)
                    NavigationLink("Update the agent") { UpdateAgentView() }
                }
            } else if let error {
                VStack(spacing: 16) {
                    Image(systemName: "iphone.slash").font(.system(size: 56)).foregroundStyle(.secondary)
                    Text("No Android screen").font(.title2)
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 640)
                    Button("Try again") { start() }
                }
            } else {
                VStack(spacing: 14) {
                    ProgressView().scaleEffect(1.5)
                    Text("Connecting to the Android screen…").foregroundStyle(.secondary)
                }
            }

            if frame != nil {
                VStack {
                    HStack {
                        Label("redroid", systemImage: "dot.radiowaves.left.and.right")
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                        Spacer()
                    }
                    .padding(32)
                    Spacer()
                    // Same vibe loop as the browser lane: prompt from the
                    // couch, watch the Android screen pick up the change.
                    VibeTurnPanel(projectName: "the app on screen")
                        .padding(.horizontal, 32)
                        .padding(.bottom, 30)
                }
            }
        }
        .onAppear { start() }
        .onDisappear { pollTask?.cancel() }
    }

    private func start() {
        error = nil
        scopeDenied = false
        pollTask?.cancel()
        pollTask = Task { await poll() }
    }

    private func poll() async {
        // Runner/render split: the droid frame streams from the RENDER box.
        guard let client = store.renderClient() else {
            error = store.machineSplitActive
                ? "Your render machine needs the relay to be reachable from this TV."
                : "No machine selected"
            return
        }
        var consecutiveFailures = 0
        while !Task.isCancelled {
            do {
                let data = try await client.droidFrame()
                if let img = UIImage(data: data) {
                    frame = img
                    lastFrameAt = Date()
                    error = nil
                    consecutiveFailures = 0
                }
            } catch {
                // Scope denial is deterministic — stop polling on the FIRST
                // one instead of burning the 3-strike ladder on a verdict that
                // cannot change.
                if FailureSignals.isSessionScopeDenied(error) {
                    scopeDenied = true
                    frame = nil
                    return
                }
                consecutiveFailures += 1
                // Only surface the error once we've lost the stream (not on a
                // single dropped frame) — and only clear the image if there was
                // never one, so a transient blip doesn't blank a running screen.
                if consecutiveFailures >= 3 {
                    self.error = error.localizedDescription
                    if frame == nil || (lastFrameAt.map { Date().timeIntervalSince($0) > 8 } ?? true) {
                        frame = nil
                    }
                }
            }
            try? await Task.sleep(nanoseconds: 500_000_000) // ~2 fps
        }
    }
}
