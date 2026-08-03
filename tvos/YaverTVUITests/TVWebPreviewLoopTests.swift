// TVWebPreviewLoopTests.swift — the REAL tvOS app, in the simulator, showing
// pixels streamed from a REAL box.
//
// ─── Why this target exists ────────────────────────────────────────────────
//
// Every "tvOS closed loop" until now sampled a frame the BOX captured at TV
// geometry. That proves the server half — runner edits, dev server rebuilds,
// render pipeline produces the right pixels — and `native-headless-vibe.mjs`
// says so on every run. It proves nothing about the TV app: not that it can
// fetch a frame, not that it decodes one, not that anything reaches a screen.
//
// That gap was not theoretical. `AgentClient.previewFrame` omitted `?project=`,
// so the endpoint answered `{"error":"project query param required"}` instead
// of PNG bytes, `UIImage(data:)` returned nil, and a bare `if let` with no else
// swallowed it. WebPreviewStreamView could never have displayed a frame in
// production, and no arc could see that, because no arc ran the app.
//
// This test closes that. The app runs in the tvOS simulator, points at a real
// machine, navigates to the web preview, and the frames it renders are captured
// from the SIMULATOR'S OWN SCREEN.
//
// ─── Division of labour ────────────────────────────────────────────────────
//
// This file drives the UI and writes screenshots. It does NOT decide colour.
//
// The colour verdict lives in web/lib/vibeVerdict.ts and is unit-tested there,
// because it has been wrong twice in a way that made a WORKING product look
// broken. Porting it to Swift would create a second implementation to drift —
// the exact failure this repo keeps paying for. So the orchestrator
// (e2e/tvos-sim-vibe-loop.mjs) classifies the frames this test leaves behind,
// with the same function the web and headless arcs use.
//
// ─── Configuration, not test hooks ─────────────────────────────────────────
//
// The box, token and project arrive through UserDefaults' argument domain,
// exactly as VisionDashboardUITests already does. No production code has a test
// hook. Note the argument domain PROPERTY-LIST-parses each `-key value` pair,
// so JSON must be wrapped as a quoted plist string or it is silently dropped
// and the app quietly falls back to persisted simulator state.

import XCTest

final class TVWebPreviewLoopTests: XCTestCase {

    /// Where to leave screenshots for the orchestrator to classify.
    private var shotDir: String {
        ProcessInfo.processInfo.environment["YAVER_SHOT_DIR"] ?? NSTemporaryDirectory()
    }
    private var boxHost: String { env("YAVER_BOX_HOST", "100.75.123.78") }
    private var boxPort: Int { Int(env("YAVER_BOX_PORT", "18080")) ?? 18080 }
    private var token: String { env("YAVER_BOX_TOKEN", "") }
    private var projectName: String { env("YAVER_PROJECT", "mobile") }
    /// How long to sit on the preview capturing frames. The orchestrator starts
    /// the vibe, so this must outlast a runner turn plus a rebuild.
    private var captureSeconds: Int { Int(env("YAVER_CAPTURE_SECONDS", "420")) ?? 420 }

    private func env(_ k: String, _ fallback: String) -> String {
        let v = ProcessInfo.processInfo.environment[k] ?? ""
        return v.isEmpty ? fallback : v
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(token.isEmpty, "YAVER_BOX_TOKEN not set — this arc needs a real box session")
    }

    func testWebPreviewStreamsRealPixelsFromTheBox() throws {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"closed-loop-box","name":"\#(boxHost)","host":"\#(boxHost)","port":\#(boxPort)}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", token,
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "closed-loop-box",
        ]
        app.launch()

        // Capture the very first screen no matter what happens next: if the app
        // never gets past sign-in or a "couldn't reach" notice, the ORACLE reads
        // that off this frame and the run reports a named cause instead of a
        // bare timeout.
        snap(app, "0000-launch")

        // NAVIGATION IS DERIVED FROM EVIDENCE, NOT GUESSED.
        //
        // tvOS has neither `tap()` nor `XCUIElement.select()` — both are
        // compiled out. The TV is driven entirely by the Siri Remote: move
        // focus with directional presses, activate with .select. The first two
        // versions of this test discovered that as build errors rather than as
        // a wrong click, which is the cheap way to find it.
        //
        // Rather than guess a focus path through a screen nobody has looked at,
        // this records the UI it actually finds and lets the orchestrator's
        // oracle read it back. Guessed selectors are what cost the mobile arc
        // three runs; the same mistake is available here and is not being made.
        // Once a run shows what the TV renders, the presses below become
        // specific instead of exploratory.
        let labels = app.descendants(matching: .any)
            .allElementsBoundByIndex.prefix(40)
            .compactMap { $0.label.isEmpty ? nil : $0.label }
        XCTContext.runActivity(named: "on screen: \(labels.joined(separator: " | "))") { _ in }

        // A tvOS screen auto-focuses its first focusable element, so pressing
        // .select activates whatever the app considers primary. That is the
        // honest first move for an unexplored screen — and every frame is
        // captured either way, so a wrong move is diagnosable rather than fatal.
        if app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", projectName)).count > 0 {
            XCUIRemote.shared.press(.select)
        } else {
            snap(app, "0001-no-project-card")
        }

        // Sit on the preview and photograph the app's own screen. The
        // orchestrator triggers the vibe; this just records what the TV shows.
        let deadline = Date().addingTimeInterval(TimeInterval(captureSeconds))
        var i = 1
        while Date() < deadline {
            snap(app, String(format: "%04d-preview", i))
            i += 1
            Thread.sleep(forTimeInterval: 15)
        }
    }

    /// Screenshot the SIMULATOR SCREEN (not a view hierarchy render) and write
    /// it where the orchestrator can find it.
    ///
    /// XCUIScreen.main.screenshot() is what a viewer would see, which is the
    /// point: a verdict taken from anything else would be a statement about the
    /// app's internals rather than about pixels.
    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let url = URL(fileURLWithPath: shotDir).appendingPathComponent("\(name).png")
        do {
            try FileManager.default.createDirectory(
                at: URL(fileURLWithPath: shotDir), withIntermediateDirectories: true)
            try shot.pngRepresentation.write(to: url)
        } catch {
            // An artifact failure must never change a verdict, but it must not
            // be silent either — a run with no frames and no explanation is the
            // SILENT verdict this suite exists to remove.
            XCTContext.runActivity(named: "could not write \(url.lastPathComponent): \(error)") { _ in }
        }
        // Also attach, so a failed run is readable from the .xcresult alone.
        let att = XCTAttachment(screenshot: shot)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }
}
