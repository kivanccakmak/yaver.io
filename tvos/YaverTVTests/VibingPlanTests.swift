import XCTest
@testable import YaverTV

final class VibingPlanTests: XCTestCase {
    private func project(_ framework: String) -> ProjectSummary {
        ProjectSummary(
            name: "fixture",
            path: "/tmp/fixture",
            framework: framework,
            branch: "main",
            gitRemote: nil,
            frameworks: [framework],
            surfaces: ["mobile", "web"],
            testSurfaces: ["browser", "webrtc"],
            isMonorepo: false,
            subframeworks: nil
        )
    }

    private var expoCapabilities: ProjectPreviewCapabilities {
        ProjectPreviewCapabilities(
            workDir: "/tmp/fixture",
            framework: "expo",
            selfDevelopment: false,
            hasPairedDevice: false,
            options: [
                ProjectPreviewOption(id: "dev-server", label: "Browser Reload", supported: true, primary: true, reason: nil, framework: "expo"),
                ProjectPreviewOption(id: "remote-runtime", label: "Stream over WebRTC", supported: true, primary: false, reason: nil, framework: "expo"),
            ],
            reason: nil
        )
    }

    private func registryDevice(
        id: String,
        name: String,
        online: Bool,
        lastHeartbeat: Double
    ) -> RegisteredDevice {
        RegisteredDevice(
            deviceId: id, name: name, alias: nil, platform: "linux",
            isOnline: online, quicHost: "127.0.0.1", quicPort: 18080,
            localIps: [], relayConnected: online, agentVersion: nil,
            managed: false, machineId: nil, lastHeartbeat: lastHeartbeat,
            runners: nil, installedRunnerIds: nil
        )
    }

    private func userSettings(primary: String?, secondary: String?) throws -> MachineRegistry.UserSettings {
        var raw: [String: Any] = [:]
        if let primary { raw["primaryDeviceId"] = primary }
        if let secondary { raw["secondaryDeviceId"] = secondary }
        return try JSONDecoder().decode(
            MachineRegistry.UserSettings.self,
            from: JSONSerialization.data(withJSONObject: raw)
        )
    }

    func testExpoOffersFramesAndInteractiveWebRTCOnTV() {
        let choices = tvPreviewChoices(project: project("expo"), capabilities: expoCapabilities)
        XCTAssertEqual(choices.first?.destination, .webFrames)
        XCTAssertEqual(choices.first?.available, true)
        let webrtc = choices.first { $0.id == "remote-runtime" }
        XCTAssertEqual(webrtc?.available, true)
        XCTAssertEqual(webrtc?.destination, .interactiveWebRTC)
        XCTAssertTrue(webrtc?.detail.contains("Siri Remote pointer") == true)
        XCTAssertEqual(tvOSRenderLaneVerdicts.first { $0.id == "webrtc" }?.usable, true)
    }

    func testFlutterUsesTheBrowserFrameLane() {
        let flutter = project("flutter")
        XCTAssertEqual(flutter.kind, .web)
    }

    func testRelayWorksWithOrWithoutDirectOrTailscaleHostAndNeverLeaksPasswordInURL() {
        let relayOnly = BoxTarget(
            id: "box-id", name: "fixture", host: "", port: 18080,
            relayBaseUrl: "https://relay.example", relayPassword: "super-secret"
        )
        XCTAssertEqual(relayOnly.requestEndpoints(path: "/health").count, 1)
        XCTAssertFalse(relayOnly.requestEndpoints(path: "/health")[0].url.absoluteString.contains("super-secret"))

        let withDirect = BoxTarget(
            id: "box-id", name: "fixture", host: "100.64.1.2", port: 18080,
            relayBaseUrl: "https://relay.example", relayPassword: "super-secret"
        )
        XCTAssertEqual(withDirect.requestEndpoints(path: "/health").count, 2)
        XCTAssertFalse(withDirect.opsEndpoints.contains { $0.url.absoluteString.contains("super-secret") })
        XCTAssertEqual(withDirect.opsEndpoints.map(\.relay), [false, true])

        XCTAssertEqual(relayOnly.opsEndpoints.count, 1)
        XCTAssertEqual(relayOnly.opsEndpoints.first?.relay, true)
    }

    func testTaskCreateResponseAcceptsTaskIdAndRunnerId() throws {
        let payload = Data(#"{"taskId":"task-new","status":"queued","runnerId":"codex"}"#.utf8)
        let task = try JSONDecoder().decode(TaskSummary.self, from: payload)
        XCTAssertEqual(task.id, "task-new")
        XCTAssertEqual(task.runner, "codex")
        XCTAssertNil(task.title)
    }

    func testTaskDetailDecodesConversationTurns() throws {
        let payload = Data(#"{"id":"task-live","status":"running","runner":"claude","turns":[{"role":"user","content":"Ship it","timestamp":"2026-08-15T10:00:00Z"},{"role":"assistant","content":"Working","timestamp":null}]}"#.utf8)
        let task = try JSONDecoder().decode(TaskSummary.self, from: payload)
        XCTAssertEqual(task.turns?.map(\.role), ["user", "assistant"])
        XCTAssertEqual(task.turns?.last?.content, "Working")
    }

    func testLiveChatContinuesInPlace() {
        XCTAssertEqual(tvChatFollowUpAction(status: "running", runner: "codex"), .continueCurrent)
        XCTAssertEqual(tvChatFollowUpAction(status: "queued", runner: "codex"), .continueCurrent)
    }

    func testTerminalChatForksSilentlyToRecordedRunner() {
        for status in ["completed", "review", "failed", "stopped"] {
            XCTAssertEqual(tvChatFollowUpAction(status: status, runner: "opencode"), .forkSameRunner("opencode"))
        }
    }

    func testTerminalChatHasAStableRunnerFallback() {
        XCTAssertEqual(tvChatFollowUpAction(status: "completed", runner: nil), .forkSameRunner("claude"))
    }

    func testTVAutoConnectUsesPrimaryBeforeAlphabeticalOrder() throws {
        let now = 10_000_000.0
        let alphabetical = registryDevice(id: "a", name: "A Mac", online: true, lastHeartbeat: now)
        let primary = registryDevice(id: "ubuntu", name: "Ubuntu 4 GB", online: true, lastHeartbeat: now)

        let ranked = rankedAutoConnectTargets(
            devices: [alphabetical, primary],
            settings: try userSettings(primary: "ubuntu", secondary: nil),
            nowMs: now
        )

        XCTAssertEqual(ranked.first?.0.deviceId, "ubuntu")
        XCTAssertEqual(ranked.first?.1, .primary)
    }

    func testTVAutoConnectPreservesPrimaryThenSecondaryDespiteStalePresence() throws {
        let now = 10_000_000.0
        let primary = registryDevice(id: "primary", name: "Primary", online: false, lastHeartbeat: now)
        let secondary = registryDevice(id: "secondary", name: "Secondary", online: true, lastHeartbeat: now)
        let unrelated = registryDevice(id: "other", name: "A Different Box", online: true, lastHeartbeat: now)

        let ranked = rankedAutoConnectTargets(
            devices: [unrelated, primary, secondary],
            settings: try userSettings(primary: "primary", secondary: "secondary"),
            nowMs: now
        )

        XCTAssertEqual(ranked.map { $0.0.deviceId }, ["primary", "secondary"])
        XCTAssertEqual(ranked.map(\.1), [.primary, .secondary])
    }

    func testTVAutoConnectRanksLiveOwnerBeforeOfflineOwner() throws {
        let now = 10_000_000.0
        let offline = registryDevice(id: "offline", name: "A Offline Box", online: false, lastHeartbeat: now)
        let live = registryDevice(id: "live", name: "Z Live Box", online: true, lastHeartbeat: now)

        let ranked = rankedAutoConnectTargets(
            devices: [offline, live],
            settings: try userSettings(primary: nil, secondary: nil),
            nowMs: now
        )

        XCTAssertEqual(ranked.map { $0.0.deviceId }, ["live", "offline"])
        XCTAssertEqual(ranked.first?.1, .machine)
    }
}
