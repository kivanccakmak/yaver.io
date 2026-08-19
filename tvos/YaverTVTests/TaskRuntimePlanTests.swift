import XCTest
@testable import YaverTV

final class TaskRuntimePlanTests: XCTestCase {
    func testRemoteRunnerDoesNotRequireRenderBox() {
        let plan = TVTaskRuntimePlan.resolve(
            authenticated: true,
            runnerDeviceID: "runner-1",
            hasRunnerBox: true
        )

        XCTAssertEqual(plan.kind, .remoteRunner)
        XCTAssertTrue(plan.available)
        XCTAssertFalse(plan.requiresRender)
        XCTAssertEqual(plan.runnerDeviceID, "runner-1")
    }

    func testMissingRunnerIsNamedBoxlessInsertionPointNotRenderFailure() {
        let plan = TVTaskRuntimePlan.resolve(
            authenticated: true,
            runnerDeviceID: nil,
            hasRunnerBox: false
        )

        XCTAssertEqual(plan.kind, .boxlessUnavailable)
        XCTAssertFalse(plan.available)
        XCTAssertFalse(plan.requiresRender)
    }

    func testSignedOutIsNotConfusedWithMissingRunner() {
        let plan = TVTaskRuntimePlan.resolve(
            authenticated: false,
            runnerDeviceID: "runner-1",
            hasRunnerBox: true
        )

        XCTAssertEqual(plan.kind, .signedOut)
        XCTAssertFalse(plan.available)
        XCTAssertFalse(plan.requiresRender)
    }
}
