import SwiftUI
import UIKit
import XCTest
@testable import YaverTV

@MainActor
final class YaverDictationFieldTests: XCTestCase {
    func testDefaultRequestDoesNotOpenReplyKeyboard() {
        var text = ""
        let bridge = YaverDictationField(text: Binding(get: { text }, set: { text = $0 }))
        let coordinator = bridge.makeCoordinator()

        XCTAssertEqual(coordinator.lastEditingRequest, 0)
    }

    func testContinuityKeyboardBatchCommitSubmitsWithoutReturn() {
        var committed = ""
        var submitCount = 0
        let submitted = expectation(description: "batch dictation submits")
        let bridge = YaverDictationField(
            text: Binding(get: { committed }, set: { committed = $0 }),
            onEndEditing: {
                submitCount += 1
                submitted.fulfill()
            },
            autoSubmitBatchInput: true
        )
        let coordinator = bridge.makeCoordinator()
        let field = UITextField()
        coordinator.field = field
        coordinator.textFieldDidBeginEditing(field)

        XCTAssertTrue(coordinator.textField(
            field,
            shouldChangeCharactersIn: NSRange(location: 0, length: 0),
            replacementString: "First blue Done"
        ))
        field.text = "First blue Done"

        wait(for: [submitted], timeout: 2)
        XCTAssertEqual(committed, "First blue Done")
        XCTAssertEqual(submitCount, 1)
    }

    func testPersistentTaskComposerCanSubmitAnotherBatchAfterHostClearsFirst() {
        var committed = ""
        var submitCount = 0
        let first = expectation(description: "first phrase submits")
        let second = expectation(description: "second phrase submits")
        let bridge = YaverDictationField(
            text: Binding(get: { committed }, set: { committed = $0 }),
            onEndEditing: {
                submitCount += 1
                if submitCount == 1 { first.fulfill() }
                if submitCount == 2 { second.fulfill() }
            },
            autoSubmitBatchInput: true
        )
        let coordinator = bridge.makeCoordinator()
        let field = UITextField()
        coordinator.field = field
        coordinator.textFieldDidBeginEditing(field)

        XCTAssertTrue(coordinator.textField(
            field,
            shouldChangeCharactersIn: NSRange(location: 0, length: 0),
            replacementString: "First follow-up"
        ))
        field.text = "First follow-up"
        wait(for: [first], timeout: 2)

        // TaskDetailView accepted the phrase and cleared its binding while the
        // keyboard stayed open so the user can keep talking.
        committed = ""
        field.text = ""
        coordinator.prepareForNextSubmittedPhrase()

        XCTAssertTrue(coordinator.textField(
            field,
            shouldChangeCharactersIn: NSRange(location: 0, length: 0),
            replacementString: "Second follow-up"
        ))
        field.text = "Second follow-up"
        wait(for: [second], timeout: 2)

        XCTAssertEqual(committed, "Second follow-up")
        XCTAssertEqual(submitCount, 2)
    }

}
