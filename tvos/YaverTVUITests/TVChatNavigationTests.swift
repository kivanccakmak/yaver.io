// TVChatNavigationTests.swift — Siri Remote focus contract for native Chat.
//
// This is deliberately a no-backend navigation arc. Task history may be slow
// or unavailable; the composer entry must still exist, own focus, and lead to
// a prompt whose next downward focus stop is Start. That is the couch mechanic,
// and it can be proven without a production token or mutable server fixture.

import XCTest

final class TVChatNavigationTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDirectChatRouteOpensKeyboardWithoutStartPage() throws {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()

        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8), "Chat must expose New vibe even while task history fails or loads")
        XCTAssertTrue(newVibe.hasFocus, "Direct Chat route must default focus to New vibe")

        XCUIRemote.shared.press(.select)
        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "Selecting New vibe must open the composer")
        XCTAssertFalse(app.buttons["chat.start-vibe"].exists, "New vibe must not add a second Start page")
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "Selecting New vibe must activate the tvOS keyboard without another Select press"
        )
    }

    func testTaskChoicesStayBehindOneEllipsisPanel() throws {
        let app = launchChat()
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        // Choice inventory must not compete with the prompt until requested.
        XCTAssertFalse(app.navigationBars["Task settings"].exists)
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))

        let more = app.buttons["chat.task-settings"]
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        // tvOS has no coordinate tap. Move focus from the prompt to the lone
        // header action, then press Select like the Siri Remote does.
        for _ in 0..<3 where !more.hasFocus {
            XCUIRemote.shared.press(.up)
        }
        XCTAssertTrue(more.hasFocus, "The ellipsis must be reachable from the prompt with the remote")
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(
            app.navigationBars["Task settings"].waitForExistence(timeout: 5),
            "One ellipsis must reveal project, runner, model, and multi-MCP choices"
        )
        XCTAssertTrue(app.staticTexts["Project"].exists)
        XCTAssertTrue(app.staticTexts["Runner"].exists)
        XCTAssertTrue(app.staticTexts["Model"].exists)
        XCTAssertTrue(app.staticTexts["MCP tools"].exists)
        XCTAssertTrue(app.staticTexts["No project"].exists)
    }

    func testMenuReturnsFromDevicesSheetAndVisibleBackExists() throws {
        let app = launchDashboard()
        XCTAssertTrue(app.buttons["dashboard.chat"].waitForExistence(timeout: 8))

        // One horizontal dashboard rail: Chat → Vibing → Devices → Settings.
        // Devices is two Rights from Chat.
        XCUIRemote.shared.press(.right)
        XCUIRemote.shared.press(.right)
        XCUIRemote.shared.press(.select)

        let back = app.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 8), "The machine picker needs a visible way back, not only an undocumented Menu gesture")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(app.buttons["dashboard.chat"].waitForExistence(timeout: 5), "Menu must dismiss Devices to the dashboard")
    }

    func testMenuUnwindsComposerThenChat() throws {
        let app = launchDashboard()
        let chat = app.buttons["dashboard.chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 8))
        XCTAssertTrue(chat.hasFocus)

        XCUIRemote.shared.press(.select)
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.textFields["chat.prompt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        // First Menu closes the keyboard; second Menu dismisses the one-step
        // prompt surface. There is no intermediate Start/Cancel page.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 3),
            "The first Menu press must close the system keyboard"
        )
        // Do not send the sheet-dismiss press during the keyboard's dismissal
        // animation. tvOS drops that second remote event; a real user cannot
        // press both at the same timestamp, but the old test did exactly that.
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(newVibe.waitForExistence(timeout: 5), "Menu must dismiss the composer to Chat")
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(chat.waitForExistence(timeout: 5), "Menu must pop Chat to the dashboard")
    }

    func testComposerPromptIsActiveTextResponder() throws {
        // Simulator proxy for Siri Remote dictation. tvOS Simulator cannot
        // emit the mic button at all (hardware-only, see deploy-tvos.sh), but
        // Mac keyboard events reach a field ONLY when the UIKit editing session
        // is active — the same responder the mic dictates into on a real TV.
        // A focused-but-not-editing field (the original defect) inserts nothing.
        let app = launchChat()
        let newVibe = app.buttons["chat.new-vibe"]
        XCTAssertTrue(newVibe.waitForExistence(timeout: 8))
        XCUIRemote.shared.press(.select)
        let prompt = app.textFields["chat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "Selecting New vibe must activate the tvOS keyboard without another Select press"
        )

        prompt.typeText("hello couch")
        var value = prompt.value as? String ?? ""
        for _ in 0..<10 where !value.contains("hello") {
            sleep(1)
            value = prompt.value as? String ?? ""
        }
        XCTAssertTrue(
            value.contains("hello couch"),
            "Typing must land in the prompt — the field must be the active text-input responder, not merely focus-ring-selected. Got value: '\(value)'"
        )

        // Menu closes the keyboard; the field keeps focus so Up still reaches
        // the header ellipsis (focus must not drop off the field).
        XCUIRemote.shared.press(.menu)
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 3),
            "The first Menu press must close the system keyboard"
        )
        let more = app.buttons["chat.task-settings"]
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        for _ in 0..<3 where !more.hasFocus {
            XCUIRemote.shared.press(.up)
        }
        XCTAssertTrue(more.hasFocus, "Up from the prompt must reach the ellipsis after the keyboard closes")
    }

    private func launchDashboard() -> XCUIApplication {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            // Any unrecognised value means dashboard and overrides a stale
            // deep-route value left in simulator defaults.
            "-yaver.tv.startAt", "dashboard",
        ]
        app.launch()
        return app
    }

    private func launchChat() -> XCUIApplication {
        let app = XCUIApplication()
        let boxJSON = #"[{"id":"navigation-box","name":"Navigation Test","host":"127.0.0.1","port":18080}]"#
        let plistQuoted = "\"" + boxJSON.replacingOccurrences(of: "\"", with: "\\\"") + "\""
        app.launchArguments = [
            "-yaver.tv.token", "navigation-audit",
            "-yaver.tv.boxes", plistQuoted,
            "-yaver.tv.selectedBox", "navigation-box",
            "-yaver.tv.startAt", "chat",
        ]
        app.launch()
        return app
    }
}
