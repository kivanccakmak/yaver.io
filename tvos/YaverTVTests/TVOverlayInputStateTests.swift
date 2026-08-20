import XCTest
@testable import YaverTV

final class TVOverlayInputStateTests: XCTestCase {
    func testInactiveMenuDismissesVibing() {
        var state = TVOverlayInputState()

        XCTAssertEqual(state.requestExit(), .dismissVibing)
    }

    func testMoveIsClaimedOnceAcrossFocusedAndParentHandlers() {
        var state = TVOverlayInputState()
        state.enter()

        XCTAssertTrue(state.claimMove())
        XCTAssertFalse(state.claimMove(), "The same physical arrow must not execute twice when it bubbles")

        state.completeMoveDelivery()
        XCTAssertTrue(state.claimMove(), "A later physical arrow must not be swallowed by the duplicate guard")
    }

    func testFirstMenuCannotBubbleIntoDashboardDismissal() {
        var state = TVOverlayInputState()
        state.enter()

        XCTAssertEqual(state.requestExit(), .leaveOverlay)
        XCTAssertEqual(state.requestExit(), .ignoreDuplicate,
                       "The parent handler must not reinterpret the overlay's Menu press as route navigation")
        XCTAssertTrue(state.isActive, "Overlay ownership stays active until the event-turn handoff completes")

        state.completeExitHandoff()
        XCTAssertFalse(state.isActive)
        XCTAssertEqual(state.requestExit(), .dismissVibing,
                       "Only a subsequent Menu press may return to Dashboard")
    }

    func testExitHandoffRejectsDirectionalInput() {
        var state = TVOverlayInputState()
        state.enter()
        XCTAssertEqual(state.requestExit(), .leaveOverlay)

        XCTAssertFalse(state.claimMove(), "A direction from the same handoff turn must not reactivate the overlay")
    }
}
