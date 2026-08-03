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
        env("YAVER_SHOT_DIR", NSTemporaryDirectory())
    }
    private var boxHost: String { env("YAVER_BOX_HOST", "100.75.123.78") }
    private var boxPort: Int { Int(env("YAVER_BOX_PORT", "18080")) ?? 18080 }
    private var token: String { env("YAVER_BOX_TOKEN", "") }
    private var projectName: String { env("YAVER_PROJECT", "mobile") }
    /// How long to sit on the preview capturing frames. The orchestrator starts
    /// the vibe, so this must outlast a runner turn plus a rebuild.
    private var captureSeconds: Int { Int(env("YAVER_CAPTURE_SECONDS", "420")) ?? 420 }

    /// Read configuration from the environment.
    ///
    /// xcodebuild does NOT forward its own environment to the test process. It
    /// forwards ONLY variables prefixed `TEST_RUNNER_`, with the prefix
    /// stripped. Setting `YAVER_BOX_TOKEN=…` on the xcodebuild command line
    /// therefore reaches nothing, the token reads empty, and setUpWithError
    /// skips — while the suite reports "Executed 1 test, with 1 test skipped
    /// and 0 failures" and xcodebuild EXITS 0.
    ///
    /// Measured on the first run of this test, 2026-08-03. A skipped arc that
    /// exits 0 is a false green with a receipt, so both halves are handled:
    /// callers pass TEST_RUNNER_YAVER_*, and the orchestrator treats "skipped"
    /// as not-a-pass rather than trusting the exit code.
    ///
    /// Both spellings are accepted so a human running this by hand from Xcode
    /// (where the scheme's environment IS forwarded verbatim) does not have to
    /// know the rule.
    private func env(_ k: String, _ fallback: String) -> String {
        let e = ProcessInfo.processInfo.environment
        let v = e[k] ?? e["TEST_RUNNER_" + k] ?? ""
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

        // NAVIGATION, NOW DERIVED FROM EVIDENCE.
        //
        // The first run of this test recorded what the TV actually renders
        // rather than guessing a focus path — and the answer was not the
        // dashboard at all. The oracle read:
        //
        //   "Box asleep — 100.75.123.78 isn't answering, and it can't be woken
        //    from the TV, start it from your computer or phone."
        //
        // …for a box answering GET /info with 200 throughout. ATS was refusing
        // cleartext to 100.64/10 before a packet left the device. Guessed
        // selectors would have reported "element not found" and taught nobody
        // anything; the screenshot named a real product bug (fixed in
        // tvos/YaverTV/Info.plist).
        //
        // With that fixed the dashboard renders, and these are its real labels:
        //   Session · Tasks · Capture · Feedback · Projects · Android · Runtime
        focusAndSelect(app, label: "Projects")
        snap(app, "0001-projects")

        // Then the project card itself. Tolerant on purpose: the card's label
        // carries the project name plus framework chrome that changes.
        focusAndSelect(app, label: projectName)
        snap(app, "0002-opened")

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


    /// Move focus to the element whose label contains `label`, then press
    /// Select on the Siri Remote.
    ///
    /// tvOS has no tap() and no XCUIElement.select() — both are compiled out.
    /// The ONLY way to activate something is to give it focus and press the
    /// remote, so focus has to be walked to. This presses .down then .right in
    /// a bounded sweep, checking `hasFocus` after each step.
    ///
    /// Bounded, and it does NOT fail the test when the element never focuses.
    /// A missing control is far better diagnosed from the screenshot the caller
    /// takes next — "no such element" says less than a picture of the screen
    /// that does not contain it.
    @discardableResult
    private func focusAndSelect(_ app: XCUIApplication, label: String, steps: Int = 12) -> Bool {
        let match = NSPredicate(format: "label CONTAINS[c] %@", label)
        // app.buttons, NOT app.descendants(matching: .any).
        //
        // `descendants(matching: .any)` takes a FULL accessibility snapshot of
        // the entire tree on every evaluation. Doing that inside a focus sweep
        // timed the runner out — "Restarting after unexpected exit, crash, or
        // test timeout", 0 tests executed, one frame on disk, alongside
        // FBSSceneSnapshotErrorDomain code 4 in the log. The query was the
        // defect, not the app.
        //
        // buttons is a narrow, cheap query, and on this screen every focusable
        // control is one.
        let candidates = app.buttons.matching(match)
        for i in 0..<steps {
            if candidates.count > 0, candidates.element(boundBy: 0).hasFocus {
                XCUIRemote.shared.press(.select)
                Thread.sleep(forTimeInterval: 2)
                return true
            }
            XCUIRemote.shared.press(i % 3 == 2 ? .right : .down)
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTContext.runActivity(named: "never focused a control matching \(label)") { _ in }
        return false
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
