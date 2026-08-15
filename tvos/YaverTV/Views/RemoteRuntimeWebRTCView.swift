// RemoteRuntimeWebRTCView.swift — drive a remote phone/browser app from a TV.
//
// Media and input deliberately use separate planes:
//   • WebRTC receives H.264 when the target can encode it, or JPEG frames on a
//     data channel when it cannot.
//   • Authenticated HTTP sends tap/swipe/text/key actions through the agent's
//     single-writer control lease.
//
// That separation keeps Siri Remote input reliable over the free relay without
// coupling a click to a particular media codec.

import SwiftUI
import UIKit
import LiveKitWebRTC

private enum TVGuestControlMode: String {
    case pointer = "Pointer"
    case scroll = "Scroll"

    var symbol: String { self == .pointer ? "cursorarrow.rays" : "arrow.up.and.down" }
}

struct RemoteRuntimeWebRTCView: View {
    @EnvironmentObject private var store: YaverStore

    let project: ProjectSummary
    let form: PreviewForm

    @StateObject private var runtime = TVRemoteRuntimeController()
    @State private var cursor = CGPoint(x: 0.5, y: 0.5)
    @State private var mode: TVGuestControlMode = .pointer
    @State private var keyboardText = ""
    @State private var showingKeyboard = false
    @State private var showingVibe = false
    @State private var vibePrefill = ""
    @State private var lastMoveAt = Date.distantPast
    @State private var repeatedMoves = 0
    @FocusState private var streamFocused: Bool
    @Namespace private var defaultFocus

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 12) {
                header
                streamSurface
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                controlRail
            }
            .padding(.horizontal, 34)
            .padding(.vertical, 24)
        }
        .task(id: project.id) {
            guard let client = store.renderClient() ?? store.runnerClient() else {
                runtime.fail("No reachable render machine is selected.")
                return
            }
            await runtime.start(client: client, project: project)
            streamFocused = true
        }
        .onDisappear { runtime.stop() }
        .sheet(isPresented: $showingKeyboard) { keyboardSheet }
        .sheet(isPresented: $showingVibe) { vibeSheet }
        #if os(tvOS)
        .onMoveCommand { direction in
            guard streamFocused else { return }
            switch mode {
            case .pointer:
                movePointer(direction)
            case .scroll:
                runtime.scroll(direction)
            }
        }
        .onPlayPauseCommand {
            mode = mode == .pointer ? .scroll : .pointer
            streamFocused = true
        }
        #endif
        .accessibilityIdentifier("vibing.interactive-webrtc")
    }

    private var header: some View {
        HStack(spacing: 12) {
            Label("\(project.name) · interactive \(form.rawValue)", systemImage: "iphone.gen3.radiowaves.left.and.right")
                .font(.system(size: 17, weight: .semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.ultraThinMaterial, in: Capsule())

            if runtime.connected {
                Label(runtime.transportLabel, systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Label(runtime.status, systemImage: "antenna.radiowaves.left.and.right")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(mode == .pointer ? "Move · Select clicks" : "Directions scroll · Play/Pause returns to pointer")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var streamSurface: some View {
        GeometryReader { geometry in
            let source = runtime.sourceSize
            let fit = aspectFitRect(imageSize: source, in: geometry.size)

            ZStack {
                RoundedRectangle(cornerRadius: 28)
                    .fill(Color(white: 0.045))
                    .overlay {
                        RoundedRectangle(cornerRadius: 28)
                            .stroke(streamFocused ? Color.accentColor.opacity(0.85) : Color.white.opacity(0.14), lineWidth: streamFocused ? 4 : 2)
                    }

                Button {
                    if mode == .pointer {
                        runtime.tap(normalized: cursor)
                    } else {
                        mode = .pointer
                    }
                } label: {
                    ZStack {
                        if let track = runtime.videoTrack {
                            RemoteVideoTrackView(track: track)
                        } else if let image = runtime.frame {
                            Image(uiImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                        } else {
                            VStack(spacing: 16) {
                                if let error = runtime.error {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.system(size: 46))
                                        .foregroundStyle(.orange)
                                    Text(error)
                                        .multilineTextAlignment(.center)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: 680)
                                } else {
                                    ProgressView().scaleEffect(1.4)
                                    Text(runtime.status).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .frame(width: fit.width, height: fit.height)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focused($streamFocused)
                .prefersDefaultFocus(true, in: defaultFocus)
                .position(x: fit.midX, y: fit.midY)

                if mode == .pointer, runtime.hasMedia {
                    softCursor(in: fit)
                }

                VStack {
                    Spacer()
                    if let note = runtime.controlNote, !note.isEmpty {
                        Text(note)
                            .font(.caption)
                            .lineLimit(2)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(.bottom, 14)
                    }
                }
            }
        }
    }

    private func softCursor(in fit: CGRect) -> some View {
        let x = fit.minX + cursor.x * fit.width
        let y = fit.minY + cursor.y * fit.height
        return ZStack {
            Circle()
                .fill(Color.black.opacity(0.32))
                .frame(width: 58, height: 58)
            Circle()
                .stroke(Color.white, lineWidth: 7)
                .frame(width: 48, height: 48)
            Circle()
                .stroke(Color.accentColor, lineWidth: 3)
                .frame(width: 48, height: 48)
            Circle()
                .fill(Color.accentColor)
                .frame(width: 8, height: 8)
        }
        .shadow(color: .black.opacity(0.8), radius: 5)
        .position(x: x, y: y)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var controlRail: some View {
        HStack(spacing: 12) {
            Button {
                mode = mode == .pointer ? .scroll : .pointer
                streamFocused = true
            } label: {
                Label(mode.rawValue, systemImage: mode.symbol)
            }
            .buttonStyle(.borderedProminent)

            Button { runtime.sendKey("back", action: "back") } label: {
                Label("Guest Back", systemImage: "chevron.backward")
            }
            Button { runtime.sendKey("home", action: "home") } label: {
                Label("Guest Home", systemImage: "house")
            }
            Button { showingKeyboard = true } label: {
                Label("Keyboard", systemImage: "keyboard")
            }
            Button { showingVibe = true } label: {
                Label("Vibe", systemImage: "wand.and.stars")
            }

            Spacer()

            Button {
                Task {
                    guard let client = store.renderClient() ?? store.runnerClient() else { return }
                    await runtime.start(client: client, project: project)
                    streamFocused = true
                }
            } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(.bordered)
        .font(.system(size: 16, weight: .semibold))
    }

    private var keyboardSheet: some View {
        VStack(alignment: .leading, spacing: 24) {
            Label("Type in the guest app", systemImage: "keyboard")
                .font(.title2.bold())
            Text("Focus a field with the soft pointer first. Text is sent to that field on the remote phone or browser.")
                .foregroundStyle(.secondary)
            TextField("Text to send", text: $keyboardText)
                .textFieldStyle(.plain)
                .padding(18)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            HStack {
                Button("Cancel") { showingKeyboard = false }
                Spacer()
                Button("Send") {
                    let value = keyboardText
                    keyboardText = ""
                    showingKeyboard = false
                    runtime.sendText(value)
                    streamFocused = true
                }
                .buttonStyle(.borderedProminent)
                .disabled(keyboardText.isEmpty)
            }
        }
        .padding(60)
        .frame(width: 900, height: 430)
    }

    private var vibeSheet: some View {
        VStack(spacing: 18) {
            HStack {
                Label("Vibe while you drive", systemImage: "wand.and.stars")
                    .font(.title2.bold())
                Spacer()
                Button("Done") { showingVibe = false }
            }
            Text("The task runs on your primary runner; return to the stream to watch Fast Refresh land on the remote app.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            VibeTurnPanel(project: project, prefill: $vibePrefill)
        }
        .padding(44)
        .frame(width: 1200, height: 690)
    }

    private func movePointer(_ direction: MoveCommandDirection) {
        let now = Date()
        if now.timeIntervalSince(lastMoveAt) < 0.24 {
            repeatedMoves = min(repeatedMoves + 1, 7)
        } else {
            repeatedMoves = 0
        }
        lastMoveAt = now
        // Repeated touch-surface moves accelerate, while the first D-pad nudge
        // remains precise enough to hit a phone-sized button from the couch.
        let step = 0.025 + Double(repeatedMoves) * 0.008
        switch direction {
        case .up: cursor.y = max(0, cursor.y - step)
        case .down: cursor.y = min(1, cursor.y + step)
        case .left: cursor.x = max(0, cursor.x - step)
        case .right: cursor.x = min(1, cursor.x + step)
        @unknown default: break
        }
    }

    private func aspectFitRect(imageSize: CGSize, in container: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0,
              container.width > 0, container.height > 0 else {
            return CGRect(origin: .zero, size: container)
        }
        let scale = min(container.width / imageSize.width, container.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(
            x: (container.width - size.width) / 2,
            y: (container.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }
}

private struct RemoteVideoTrackView: UIViewRepresentable {
    let track: LKRTCVideoTrack

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> LKRTCMTLVideoView {
        let view = LKRTCMTLVideoView(frame: .zero)
        view.videoContentMode = .scaleAspectFit
        view.isEnabled = true
        context.coordinator.attach(track, to: view)
        return view
    }

    func updateUIView(_ view: LKRTCMTLVideoView, context: Context) {
        context.coordinator.attach(track, to: view)
    }

    static func dismantleUIView(_ view: LKRTCMTLVideoView, coordinator: Coordinator) {
        coordinator.detach(from: view)
    }

    final class Coordinator {
        private var track: LKRTCVideoTrack?

        func attach(_ next: LKRTCVideoTrack, to view: LKRTCMTLVideoView) {
            guard track !== next else { return }
            if let track { track.remove(view) }
            track = next
            next.add(view)
        }

        func detach(from view: LKRTCMTLVideoView) {
            track?.remove(view)
            track = nil
        }
    }
}

@MainActor
private final class TVRemoteRuntimeController: NSObject, ObservableObject {
    @Published var frame: UIImage?
    @Published var videoTrack: LKRTCVideoTrack?
    @Published var session: RemoteRuntimeSession?
    @Published var status = "Preparing the remote app…"
    @Published var transportLabel = "WebRTC"
    @Published var connected = false
    @Published var error: String?
    @Published var controlNote: String?

    var hasMedia: Bool { frame != nil || videoTrack != nil }
    var sourceSize: CGSize {
        if let dims = session?.deviceDims, dims.width > 0, dims.height > 0 {
            return CGSize(width: dims.width, height: dims.height)
        }
        if let viewport = session?.viewport, viewport.width > 0, viewport.height > 0 {
            return CGSize(width: viewport.width, height: viewport.height)
        }
        if let frame { return frame.size }
        return CGSize(width: 393, height: 852)
    }

    private struct JPEGChunks {
        let total: Int
        var parts: [String?]
    }

    private let factory = LKRTCPeerConnectionFactory()
    private let clientId = TVRemoteRuntimeController.loadClientId()
    private var client: AgentClient?
    private var peer: LKRTCPeerConnection?
    private var primerChannel: LKRTCDataChannel?
    private var eventsChannel: LKRTCDataChannel?
    private var framesChannel: LKRTCDataChannel?
    private var project: ProjectSummary?
    private var iceContinuation: CheckedContinuation<Void, Never>?
    private var iceTimeoutTask: Task<Void, Never>?
    private var fallbackTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var jpegChunks: [String: JPEGChunks] = [:]
    private var generation = UUID()

    func fail(_ message: String) {
        error = message
        status = "Interactive runtime unavailable"
    }

    func start(client: AgentClient, project: ProjectSummary) async {
        stop(closeSession: true)
        let thisGeneration = UUID()
        generation = thisGeneration
        self.client = client
        self.project = project
        frame = nil
        videoTrack = nil
        session = nil
        error = nil
        controlNote = nil
        connected = false
        transportLabel = "WebRTC"

        do {
            status = "Starting \(project.name)…"
            try await prepareBrowserLaneIfNeeded(client: client, project: project)
            guard generation == thisGeneration else { return }

            status = "Finding an interactive target…"
            let capabilities = try await client.remoteRuntimeCapabilities(for: project, refresh: true)
            guard capabilities.remoteRuntimeEligible else {
                throw AgentError(message: "This project does not expose an interactive remote runtime.")
            }
            guard let target = preferredTarget(in: capabilities.targets) else {
                let reason = capabilities.targets.first?.reason ?? "No compatible phone, simulator, device, or browser target is available on this machine."
                throw AgentError(message: reason)
            }

            status = "Opening \(target.label)…"
            let created = try await client.startRemoteRuntimeSession(
                for: project,
                targetId: target.id,
                transportMode: "direct-webrtc"
            )
            guard generation == thisGeneration else {
                try? await client.closeRemoteRuntimeSession(created.id)
                return
            }
            session = created
            if let note = created.note { controlNote = note }
            status = "Negotiating WebRTC…"
            try await negotiate(client: client, session: created)
            guard generation == thisGeneration else { return }

            watchdogTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled, let self, self.generation == thisGeneration, !self.hasMedia else { return }
                self.transportLabel = "WebRTC · HTTP fallback"
                self.controlNote = "WebRTC is still negotiating; showing authenticated relay frames until media arrives."
                self.startFrameFallback(sessionId: created.id, generation: thisGeneration)
            }
        } catch is CancellationError {
            return
        } catch {
            guard generation == thisGeneration else { return }
            fail(error.localizedDescription)
        }
    }

    func stop() { stop(closeSession: true) }

    private func stop(closeSession: Bool) {
        generation = UUID()
        iceTimeoutTask?.cancel()
        fallbackTask?.cancel()
        watchdogTask?.cancel()
        heartbeatTask?.cancel()
        iceTimeoutTask = nil
        fallbackTask = nil
        watchdogTask = nil
        heartbeatTask = nil
        iceContinuation?.resume()
        iceContinuation = nil
        eventsChannel?.close()
        framesChannel?.close()
        primerChannel?.close()
        peer?.close()
        peer = nil
        eventsChannel = nil
        framesChannel = nil
        primerChannel = nil
        jpegChunks.removeAll()
        let id = session?.id
        let client = self.client
        session = nil
        if closeSession, let id, let client {
            Task { try? await client.closeRemoteRuntimeSession(id) }
        }
    }

    func tap(normalized point: CGPoint) {
        let size = sourceSize
        sendControl(
            action: "tap",
            x: Int((point.x * size.width).rounded()),
            y: Int((point.y * size.height).rounded())
        )
    }

    func scroll(_ direction: MoveCommandDirection) {
        let size = sourceSize
        let centerX = Int(size.width * 0.5)
        let centerY = Int(size.height * 0.5)
        let dx = Int(size.width * 0.28)
        let dy = Int(size.height * 0.28)
        // A request to reveal content lower on the page is a finger swipe up.
        switch direction {
        case .up:
            sendControl(action: "swipe", x: centerX, y: centerY - dy, x2: centerX, y2: centerY + dy, durationMs: 260)
        case .down:
            sendControl(action: "swipe", x: centerX, y: centerY + dy, x2: centerX, y2: centerY - dy, durationMs: 260)
        case .left:
            sendControl(action: "swipe", x: centerX - dx, y: centerY, x2: centerX + dx, y2: centerY, durationMs: 260)
        case .right:
            sendControl(action: "swipe", x: centerX + dx, y: centerY, x2: centerX - dx, y2: centerY, durationMs: 260)
        @unknown default: break
        }
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        sendControl(action: "text", text: text)
    }

    func sendKey(_ key: String, action: String = "key") {
        sendControl(action: action, key: action == "key" ? key : nil)
    }

    private func sendControl(
        action: String,
        x: Int? = nil,
        y: Int? = nil,
        x2: Int? = nil,
        y2: Int? = nil,
        durationMs: Int? = nil,
        text: String? = nil,
        key: String? = nil
    ) {
        guard let client, let id = session?.id else { return }
        Task {
            do {
                let updated = try await client.sendRemoteRuntimeControl(
                    sessionId: id,
                    action: action,
                    x: x,
                    y: y,
                    x2: x2,
                    y2: y2,
                    durationMs: durationMs,
                    text: text,
                    key: key,
                    clientId: clientId
                )
                session = updated
                controlNote = updated.note
            } catch {
                controlNote = error.localizedDescription
            }
        }
    }

    private func prepareBrowserLaneIfNeeded(client: AgentClient, project: ProjectSummary) async throws {
        let framework = (project.framework ?? "").lowercased()
        let webCapable = project.kind == .web || ["expo", "react-native", "reactnative", "rn", "flutter", "vite", "react", "next", "nextjs"].contains(framework)
        guard webCapable else { return }
        var current = try await client.startDevServer(for: project)
        let deadline = Date().addingTimeInterval(150)
        while !Task.isCancelled {
            if let failure = current.error?.trimmingCharacters(in: .whitespacesAndNewlines), !failure.isEmpty {
                throw AgentError(message: failure)
            }
            if current.serving == true || (current.running == true && current.building != true) { break }
            guard Date() < deadline else {
                throw AgentError(message: "The \(project.name) dev server did not become ready within 2½ minutes.")
            }
            status = current.servingLabel?.isEmpty == false ? current.servingLabel! : "Starting \(project.name)…"
            try await Task.sleep(nanoseconds: 600_000_000)
            current = try await client.devServerStatus()
        }
        if ["expo", "react-native", "reactnative", "rn"].contains(framework) {
            status = "Starting the mobile web runtime…"
            _ = try await client.startWebServer()
        }
    }

    private func preferredTarget(in targets: [RemoteRuntimeTarget]) -> RemoteRuntimeTarget? {
        let enabled = targets.filter(\.enabled)
        return enabled.first(where: { $0.id == "browser-window" })
            ?? enabled.first(where: { $0.id == "ios-simulator" || $0.id == "android-emulator" })
            ?? enabled.first
    }

    private func negotiate(client: AgentClient, session: RemoteRuntimeSession) async throws {
        let credentials = try? await client.remoteRuntimeICECredentials()
        let configuration = LKRTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let servers = (credentials?.iceServers ?? []).compactMap { server -> LKRTCIceServer? in
            guard !server.urls.isEmpty else { return nil }
            return LKRTCIceServer(urlStrings: server.urls, username: server.username, credential: server.credential)
        }
        configuration.iceServers = servers.isEmpty
            ? [LKRTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
            : servers
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw AgentError(message: "tvOS could not create a WebRTC peer connection.")
        }
        self.peer = peer
        let primerConfig = LKRTCDataChannelConfiguration()
        primerChannel = peer.dataChannel(forLabel: "primer", configuration: primerConfig)
        let receive = LKRTCRtpTransceiverInit()
        receive.direction = .recvOnly
        guard peer.addTransceiver(of: .video, init: receive) != nil else {
            throw AgentError(message: "tvOS could not request the remote video track.")
        }

        let offer = try await createOffer(peer: peer, constraints: constraints)
        guard offer.sdp.contains("m=video") else {
            throw AgentError(message: "The tvOS WebRTC offer did not include a video lane.")
        }
        try await setLocal(offer, peer: peer)
        await waitForIceGathering(peer)
        guard let local = peer.localDescription else {
            throw AgentError(message: "tvOS did not produce a local WebRTC offer.")
        }
        let answer = try await client.answerRemoteRuntimeWebRTC(sessionId: session.id, offerSDP: local.sdp)
        self.session = answer.session
        if let transport = answer.transport { transportLabel = label(for: transport) }
        if let note = answer.note { controlNote = note }
        guard let answerSDP = answer.answer.sdp, !answerSDP.isEmpty else {
            throw AgentError(message: "The remote runtime returned an empty WebRTC answer.")
        }
        try await setRemote(LKRTCSessionDescription(type: .answer, sdp: answerSDP), peer: peer)
    }

    private func createOffer(peer: LKRTCPeerConnection, constraints: LKRTCMediaConstraints) async throws -> LKRTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { offer, error in
                if let error { continuation.resume(throwing: error) }
                else if let offer { continuation.resume(returning: offer) }
                else { continuation.resume(throwing: AgentError(message: "WebRTC offer creation returned no SDP.")) }
            }
        }
    }

    private func setLocal(_ description: LKRTCSessionDescription, peer: LKRTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func setRemote(_ description: LKRTCSessionDescription, peer: LKRTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func waitForIceGathering(_ peer: LKRTCPeerConnection) async {
        guard peer.iceGatheringState != .complete else { return }
        await withCheckedContinuation { continuation in
            iceContinuation = continuation
            iceTimeoutTask?.cancel()
            iceTimeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled, let self else { return }
                self.finishIceWait()
            }
        }
    }

    private func finishIceWait() {
        iceTimeoutTask?.cancel()
        iceTimeoutTask = nil
        iceContinuation?.resume()
        iceContinuation = nil
    }

    private func startFrameFallback(sessionId: String, generation: UUID) {
        guard fallbackTask == nil else { return }
        fallbackTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == generation, let client = self.client else { return }
                do {
                    let data = try await client.remoteRuntimeFrame(sessionId: sessionId)
                    if let image = UIImage(data: data) {
                        self.frame = image
                        self.connected = true
                        self.status = "Interactive stream ready"
                    }
                } catch {
                    if self.frame == nil { self.controlNote = error.localizedDescription }
                }
                try? await Task.sleep(nanoseconds: 850_000_000)
            }
        }
    }

    private func acceptJPEG(_ data: Data, fromWebRTC: Bool) {
        guard let image = UIImage(data: data) else {
            controlNote = "A remote frame arrived but tvOS could not decode it."
            return
        }
        frame = image
        connected = true
        status = "Interactive stream ready"
        if fromWebRTC {
            transportLabel = "WebRTC · JPEG"
            fallbackTask?.cancel()
            fallbackTask = nil
        }
    }

    private func handleData(_ data: Data, binary: Bool, channelLabel: String) {
        if channelLabel == "frames" {
            if binary {
                acceptJPEG(data, fromWebRTC: true)
                return
            }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["type"] as? String == "jpeg-chunk",
                  let id = object["id"] as? String,
                  let index = object["index"] as? Int,
                  let total = object["total"] as? Int,
                  let encoded = object["data"] as? String,
                  index >= 0, total > 0, index < total else { return }
            var chunk = jpegChunks[id] ?? JPEGChunks(total: total, parts: Array(repeating: nil, count: total))
            guard chunk.total == total, chunk.parts.count == total else {
                jpegChunks.removeValue(forKey: id)
                return
            }
            chunk.parts[index] = encoded
            jpegChunks[id] = chunk
            guard chunk.parts.allSatisfy({ $0 != nil }) else { return }
            jpegChunks.removeValue(forKey: id)
            if let joined = Data(base64Encoded: chunk.parts.compactMap { $0 }.joined()) {
                acceptJPEG(joined, fromWebRTC: true)
            }
            return
        }

        guard channelLabel == "events",
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch object["type"] as? String {
        case "ready":
            if let transport = object["transport"] as? String { transportLabel = label(for: transport) }
        case "dims", "rotation":
            guard let current = session,
                  let width = object["width"] as? Int,
                  let height = object["height"] as? Int else { break }
            session = RemoteRuntimeSession(
                id: current.id,
                workDir: current.workDir,
                framework: current.framework,
                targetId: current.targetId,
                targetLabel: current.targetLabel,
                platform: current.platform,
                deviceId: current.deviceId,
                displaySurface: current.displaySurface,
                viewport: current.viewport,
                transportMode: current.transportMode,
                frameTransport: current.frameTransport,
                status: current.status,
                lastCommand: current.lastCommand,
                note: current.note,
                deviceDims: RemoteRuntimeDeviceDims(
                    width: width,
                    height: height,
                    scale: object["scale"] as? Double,
                    rotation: object["rotation"] as? String
                )
            )
        case "taken-over":
            controlNote = "Another viewer took over this remote session."
            peer?.close()
        case "frame-error":
            if let message = object["error"] as? String { controlNote = message }
        default:
            if let message = object["error"] as? String { controlNote = message }
        }
    }

    private func label(for transport: String) -> String {
        if transport.hasPrefix("webrtc-rtp-h264") { return "WebRTC · H.264" }
        if transport.hasPrefix("webrtc-datachannel-jpeg") { return "WebRTC · JPEG" }
        if transport.hasPrefix("relay-jpeg-poll") { return "Relay · JPEG" }
        return transport
    }

    private func attachVideo(_ track: LKRTCVideoTrack) {
        videoTrack = track
        connected = true
        status = "Interactive stream ready"
        transportLabel = "WebRTC · H.264"
        fallbackTask?.cancel()
        fallbackTask = nil
    }

    private func beginHeartbeat() {
        guard heartbeatTask == nil else { return }
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled, let self, let channel = self.eventsChannel,
                      channel.readyState == .open else { continue }
                let data = try? JSONSerialization.data(withJSONObject: [
                    "type": "ping",
                    "ts": Int(Date().timeIntervalSince1970 * 1000),
                ])
                if let data { _ = channel.sendData(LKRTCDataBuffer(data: data, isBinary: false)) }
            }
        }
    }

    private static func loadClientId() -> String {
        let key = "yaver.tv.remote-runtime.client-id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
        let created = "tvos-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(created, forKey: key)
        return created
    }
}

extension TVRemoteRuntimeController: LKRTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {
        guard let track = stream.videoTracks.first else { return }
        Task { @MainActor [weak self] in self?.attachVideo(track) }
    }

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if newState == .failed { self.controlNote = "WebRTC ICE failed; using authenticated frame fallback." }
        }
    }

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        guard newState == .complete else { return }
        Task { @MainActor [weak self] in self?.finishIceWait() }
    }

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            dataChannel.delegate = self
            if dataChannel.label == "events" {
                self.eventsChannel = dataChannel
                self.beginHeartbeat()
            } else if dataChannel.label == "frames" {
                self.framesChannel = dataChannel
            }
        }
    }

    nonisolated func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didAdd rtpReceiver: LKRTCRtpReceiver,
        streams: [LKRTCMediaStream]
    ) {
        guard let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
        Task { @MainActor [weak self] in self?.attachVideo(track) }
    }
}

extension TVRemoteRuntimeController: LKRTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {}

    nonisolated func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        let data = buffer.data
        let binary = buffer.isBinary
        let label = dataChannel.label
        Task { @MainActor [weak self] in self?.handleData(data, binary: binary, channelLabel: label) }
    }
}
