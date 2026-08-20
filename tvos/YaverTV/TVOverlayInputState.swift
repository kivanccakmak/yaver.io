// TVOverlayInputState.swift — deterministic ownership for the Vibing preview.
//
// SwiftUI may deliver one Siri Remote command to both the focused preview and
// an enclosing command handler. Keep that delivery detail out of the view: a
// physical move is claimed once, and the first Menu press remains an overlay
// handoff until every handler for that event has had a chance to observe it.

import Foundation

enum TVOverlayExitDecision: Equatable {
    case leaveOverlay
    case dismissVibing
    case ignoreDuplicate
}

struct TVOverlayInputState: Equatable {
    private(set) var isActive = false
    private(set) var exitHandoffPending = false
    private(set) var moveClaimPending = false

    mutating func enter() {
        isActive = true
        exitHandoffPending = false
    }

    mutating func deactivate() {
        isActive = false
        exitHandoffPending = false
        moveClaimPending = false
    }

    mutating func claimMove() -> Bool {
        guard isActive, !exitHandoffPending, !moveClaimPending else { return false }
        moveClaimPending = true
        return true
    }

    mutating func completeMoveDelivery() {
        moveClaimPending = false
    }

    mutating func requestExit() -> TVOverlayExitDecision {
        if exitHandoffPending { return .ignoreDuplicate }
        guard isActive else { return .dismissVibing }
        exitHandoffPending = true
        return .leaveOverlay
    }

    mutating func completeExitHandoff() {
        deactivate()
    }
}
