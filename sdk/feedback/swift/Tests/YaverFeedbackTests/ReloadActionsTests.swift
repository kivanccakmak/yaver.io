import XCTest
@testable import YaverFeedback

final class ReloadActionsTests: XCTestCase {

    private func running(_ framework: String) -> DevServerSnapshot {
        DevServerSnapshot(running: true, framework: framework)
    }

    // ─── THE GUARD ───────────────────────────────────────────────────────────
    //
    // Prove it by breaking it: change `guard isDevBuild else { return [] }` in
    // ReloadActions.build to `guard !isDevBuild` and this single test fails
    // while every other test in this file still passes.
    func testReleaseBuildGetsNoReloadActionsAtAll() {
        let actions = ReloadActions.build(
            snapshot: running("vite"), isDevBuild: false, connected: true)

        XCTAssertTrue(actions.isEmpty)
    }

    func testDebugBuildGetsHotAndFull() {
        let actions = ReloadActions.build(
            snapshot: running("vite"), isDevBuild: true, connected: true)

        XCTAssertEqual(actions.map(\.id), [.hot, .full])
        XCTAssertTrue(actions.allSatisfy(\.enabled))
    }

    func testFrameworkFamilyMapsTheAgentNames() {
        XCTAssertEqual(ReloadActions.frameworkFamily("flutter"), .flutter)
        XCTAssertEqual(ReloadActions.frameworkFamily("expo"), .reactNative)
        XCTAssertEqual(ReloadActions.frameworkFamily("react-native"), .reactNative)
        XCTAssertEqual(ReloadActions.frameworkFamily("vite"), .web)
        XCTAssertEqual(ReloadActions.frameworkFamily("nextjs"), .web)
        XCTAssertEqual(ReloadActions.frameworkFamily(""), .unknown)
        XCTAssertEqual(ReloadActions.frameworkFamily("godot"), .unknown)
    }

    func testFlutterSecondActionIsAHotRestartNotAFullReload() {
        let actions = ReloadActions.build(
            snapshot: running("flutter"), isDevBuild: true, connected: true)

        XCTAssertEqual(actions[0].label, "Hot Reload")
        XCTAssertEqual(actions[1].label, "Hot Restart")
        XCTAssertTrue(actions[1].hint.contains("(R)"))
    }

    func testEveryOtherFrameworkCallsItAFullReload() {
        for framework in ["expo", "vite", "nextjs"] {
            let actions = ReloadActions.build(
                snapshot: running(framework), isDevBuild: true, connected: true)
            XCTAssertEqual(actions[1].label, "Full Reload", framework)
        }
    }

    func testPayloadIsFastThenFullBothOnDevReload() {
        let actions = ReloadActions.build(
            snapshot: running("flutter"), isDevBuild: true, connected: true)

        XCTAssertEqual(actions[0].path, "/dev/reload")
        XCTAssertEqual(actions[0].body, ["mode": "fast"])
        XCTAssertEqual(actions[1].path, "/dev/reload")
        XCTAssertEqual(actions[1].body, ["mode": "full"])
    }

    func testNeverOffersTheHermesBundlePathASwiftAppCannotLoad() {
        let actions = ReloadActions.build(
            snapshot: running("react-native"), isDevBuild: true, connected: true)

        XCTAssertFalse(actions.contains { $0.path == ReloadActions.reloadAppPath })
    }

    func testNoDevServerNamesTheMachineAndTheCommandThatStartsIt() {
        let actions = ReloadActions.build(
            snapshot: DevServerSnapshot(running: false),
            isDevBuild: true, connected: true, machineLabel: "primary")

        for action in actions {
            XCTAssertFalse(action.enabled)
            XCTAssertTrue(action.disabledReason?.contains("primary") == true)
            XCTAssertTrue(action.disabledReason?.contains("yaver dev start") == true)
        }
    }

    func testBuildingSaysStillBuildingNotNoDevServer() {
        let actions = ReloadActions.build(
            snapshot: DevServerSnapshot(running: true, building: true, framework: "vite"),
            isDevBuild: true, connected: true)

        XCTAssertTrue(actions[0].disabledReason?.contains("still building") == true)
    }

    func testDisconnectedSaysNotConnectedNotNoDevServer() {
        let actions = ReloadActions.build(
            snapshot: running("vite"), isDevBuild: true, connected: false)

        XCTAssertTrue(actions[0].disabledReason?.contains("Not connected") == true)
    }

    func testSnapshotFromJSONDegradesToNotRunningNeverOptimism() {
        let live = DevServerSnapshot(json: ["running": true, "framework": "flutter"])
        XCTAssertTrue(live.running)
        XCTAssertEqual(live.framework, "flutter")

        let empty = DevServerSnapshot(json: [:])
        XCTAssertFalse(empty.running)
        XCTAssertFalse(empty.building)
        XCTAssertNil(empty.framework)
    }

    func testDescribeFailureNamesACauseNeverJustFailed() {
        XCTAssertTrue(
            ReloadActions.describeFailure(status: 503, body: "dev server not available")
                .contains("No dev server is running"))

        XCTAssertTrue(
            ReloadActions.describeFailure(
                status: 500, body: "vite does not support hot reload",
                snapshot: running("vite")
            ).contains("vite"))

        XCTAssertTrue(
            ReloadActions.describeFailure(
                status: 502,
                body: "Get \"http://127.0.0.1:8081/reload\": dial tcp 127.0.0.1:8081: connect: connection refused"
            ).contains("not listening"))

        XCTAssertTrue(ReloadActions.describeFailure(status: 401, body: "").contains("sign in again"))
        XCTAssertTrue(ReloadActions.describeFailure(status: 403, body: "").contains("sign in again"))
        XCTAssertTrue(ReloadActions.describeFailure(status: 404, body: "").contains("yaver-cli@latest"))
        XCTAssertTrue(ReloadActions.describeFailure(status: 500, body: "boom").contains("yaver logs"))
        XCTAssertTrue(ReloadActions.describeFailure(status: 0, body: "").contains("yaver serve"))
    }

    /// The config default must inherit the SDK's own DEBUG flag rather than
    /// silently defaulting to true — a wrong default here is a reload button
    /// in a shipped app.
    func testConfigDevBuildDefaultsToTheCompiledInDebugFlag() {
        let config = FeedbackConfig(agentURL: "http://box:18080", authToken: "t")
        XCTAssertEqual(config.devBuild, FeedbackConfig.compiledInDebug)
    }

    func testConfigDevBuildCanBeForcedOffEvenInADebugBuild() {
        let config = FeedbackConfig(agentURL: "http://box:18080", authToken: "t", devBuild: false)
        XCTAssertFalse(config.devBuild)
    }
}
