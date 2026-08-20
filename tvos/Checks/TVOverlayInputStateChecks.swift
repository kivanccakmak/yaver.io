// TVOverlayInputStateChecks.swift — headless proof for the tvOS overlay gate.
//
// Run from the repository root; no simulator, account, or real box required:
//
//   swiftc -O -parse-as-library \
//     tvos/YaverTV/TVOverlayInputState.swift \
//     tvos/Checks/TVOverlayInputStateChecks.swift \
//     -o /tmp/yaver-tv-overlay-checks && /tmp/yaver-tv-overlay-checks

import Foundation

private var failures = 0

private func check(_ condition: Bool, _ label: String) {
    guard !condition else { return }
    failures += 1
    FileHandle.standardError.write("FAIL: \(label)\n".data(using: .utf8)!)
}

@main
enum TVOverlayInputStateChecks {
    static func main() {
        var state = TVOverlayInputState()
        check(state.requestExit() == .dismissVibing, "Menu outside overlay dismisses Vibing")

        state.enter()
        check(state.claimMove(), "the focused handler claims an overlay arrow")
        check(!state.claimMove(), "the parent handler cannot duplicate the same arrow")
        state.completeMoveDelivery()
        check(state.claimMove(), "a later physical arrow is accepted")
        state.completeMoveDelivery()

        check(state.requestExit() == .leaveOverlay, "first Menu leaves overlay")
        check(state.requestExit() == .ignoreDuplicate, "bubbled first Menu cannot dismiss Vibing")
        check(!state.claimMove(), "the exit handoff cannot be re-entered by a direction")
        state.completeExitHandoff()
        check(!state.isActive, "handoff deactivates overlay")
        check(state.requestExit() == .dismissVibing, "second physical Menu dismisses Vibing")

        if failures > 0 { exit(1) }
        print("PASS: 9 tvOS overlay input checks")
    }
}
