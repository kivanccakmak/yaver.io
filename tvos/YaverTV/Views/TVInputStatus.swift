// TVInputStatus.swift — named tvOS text-input states.
//
// Failure plumbing for the Siri Remote mic. tvOS gives the app no mic-button
// callback; the only honest signals are the UIKit first-responder state and the
// system keyboard. This reporter centralises those so every route renders the
// same named state instead of silence (AGENTS.md "Every failure must carry a
// route to its fix"). The quiet status line only appears when input needs
// attention; healthy input consumes no screen space.

import SwiftUI
import UIKit

/// Named tvOS text-input states. `.dictationUnavailable` covers the
/// system-level case (Settings → Siri & Dictation disabled) which the app
/// cannot observe programmatically — it is kept as a documented label rather
/// than a measured emission.
enum TVInputState: Equatable {
    case active
    case notActive
    case dictationUnavailable
}

final class InputStateReporter: ObservableObject {
    static let shared = InputStateReporter()

    @Published var route: String = ""
    @Published var responder = false {
        didSet {
            if responder {
                focusRequestedAt = nil
            }
        }
    }
    @Published var keyboardVisible = false
    @Published var scenePhase: String = ""
    @Published var lastTextChange: String = ""
    @Published var lastTextChangeAt: Date?
    @Published var focusRequestedAt: Date?

    // Responder-ladder measurements retained for input diagnostics and tests.
    @Published var responderAttempts = 0
    @Published var lastAttemptResult = false
    @Published var editBeginCount = 0
    @Published var editEndCount = 0

    /// Call when a route asks its field to become the input responder.
    func noteFocusRequest() {
        focusRequestedAt = Date()
    }

    /// Derived named state. `.notActive` only after the responder ladder has
    /// had its measured ~1 s window and still failed — avoids a flash while
    /// the keyboard animates in.
    var derivedState: TVInputState? {
        if responder && keyboardVisible {
            return .active
        }
        if let requestedAt = focusRequestedAt,
           Date().timeIntervalSince(requestedAt) > 1.0,
           !responder {
            return .notActive
        }
        return nil
    }

    private init() {}

    /// Called from the dictation field's `textFieldDidBeginEditing` — a first-
    /// responder UITextField on tvOS means the system keyboard is up.
    func noteEditingBegan() {
        responder = true
        keyboardVisible = true
        focusRequestedAt = nil
        editBeginCount += 1
    }

    func noteEditingEnded() {
        responder = false
        keyboardVisible = false
        editEndCount += 1
    }
}

/// Quiet one-line status shown under a prompt when dictation needs attention.
/// Per LESS-IS-MORE it renders nothing while the field is the active responder
/// — a healthy, working field earns no pixels.
struct TVInputStatusLine: View {
    @ObservedObject private var reporter = InputStateReporter.shared

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
            if reporter.derivedState == .notActive {
                Label(
                    "TV_INPUT_NOT_ACTIVE — Select the prompt once, then hold Siri. Use iPhone Apple TV Remote for text if the keyboard does not appear.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.system(size: 15))
                .foregroundStyle(.orange)
                .lineLimit(2)
            }
        }
    }
}
