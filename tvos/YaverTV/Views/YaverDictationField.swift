// YaverDictationField.swift — the ONE text input every tvOS route uses.
//
// Why this exists: SwiftUI TextField + @FocusState moves the tvOS *focus ring*
// but does not reliably engage the UIKit editing session that Siri Remote
// dictation routes into. Measured 2026-08-19 on a physical Apple TV: the mic
// button on the Siri Remote did nothing for any Yaver prompt, while the same
// remote dictated fine into YouTube's search field. This bridge wraps
// UITextField and claims first responder AFTER the view is attached to the
// window (with a bounded retry ladder covering sheet/keyboard animation), so
// the system keyboard comes up and the mic has a real text-input target.
//
// Text-input only, by construction: no microphone permission, no
// SFSpeechRecognizer, no second STT pipeline — tvOS has no app-level mic and
// the only dictation path is the OS keyboard's.

import SwiftUI
import UIKit

struct YaverDictationField: UIViewRepresentable {
    @Binding var text: String
    /// One-shot keyboard request. A route bumps this when it wants the field to
    /// become the active text-input responder (open composer → ready to
    /// dictate). Unlike a focus binding, it is NOT reactive to focus flips —
    /// SwiftUI re-asserts focus whenever the focus ring lands, which must not
    /// reopen the keyboard after Menu.
    var editingRequestID: Int = 0
    var onSubmit: () -> Void = {}
    var onEndEditing: () -> Void = {}
    /// Continuity Keyboard sends iPhone Remote dictation to tvOS as one
    /// multi-character replacement when its first blue Done ends microphone
    /// mode. It does not send Return or end editing. Enable this only on a
    /// surface where that committed phrase is itself the explicit send action.
    var autoSubmitBatchInput = false
    var placeholder: String = ""
    var font: UIFont? = nil
    var textColor: UIColor? = nil
    var tint: UIColor? = nil
    var fieldBackgroundColor: UIColor? = nil
    var fieldCornerRadius: CGFloat = 0
    var fieldContentInset: UIEdgeInsets = .zero
    var accessibilityIdentifier: String? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextField {
        let field = YaverDictationTextField()
        field.delegate = context.coordinator
        field.returnKeyType = .done
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartInsertDeleteType = .no
        field.borderStyle = .none
        field.backgroundColor = fieldBackgroundColor ?? .clear
        field.layer.cornerRadius = fieldCornerRadius
        field.clipsToBounds = fieldCornerRadius > 0
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: fieldContentInset.left, height: 1))
        field.leftViewMode = fieldContentInset.left > 0 ? .always : .never
        field.rightView = UIView(frame: CGRect(x: 0, y: 0, width: fieldContentInset.right, height: 1))
        field.rightViewMode = fieldContentInset.right > 0 ? .always : .never
        field.tintColor = tint ?? .white
        field.textColor = textColor ?? .white
        field.font = font ?? .systemFont(ofSize: 24)
        if !placeholder.isEmpty {
            field.placeholder = placeholder
            if let textColor {
                field.attributedPlaceholder = NSAttributedString(
                    string: placeholder,
                    attributes: [.foregroundColor: textColor.withAlphaComponent(0.58)]
                )
            }
        }
        if let accessibilityIdentifier {
            field.accessibilityIdentifier = accessibilityIdentifier
            field.accessibilityLabel = accessibilityIdentifier
        }
        field.addTarget(context.coordinator, action: #selector(Coordinator.textDidChange(_:)), for: .editingChanged)
        context.coordinator.field = field
        field.onDictationRecordingDidEnd = { [weak coordinator = context.coordinator] in
            coordinator?.dictationRecordingEnded()
        }
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if field.text != text {
            field.text = text
        }
        if let accessibilityIdentifier, field.accessibilityIdentifier != accessibilityIdentifier {
            field.accessibilityIdentifier = accessibilityIdentifier
        }
        // One-shot keyboard open, exactly once per route bump. Focus is kept
        // purely in SwiftUI's hands (`.focused` + `@FocusState`): the tvOS
        // focus engine dismisses the keyboard natively when focus leaves the
        // field, and re-asserting focus on a field must NOT reopen editing —
        // that divergence is exactly why the field could be focus-ring-selected
        // yet never the active text-input responder.
        if editingRequestID != coordinator.lastEditingRequest {
            coordinator.lastEditingRequest = editingRequestID
            coordinator.requestFirstResponder()
        }
    }

    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        coordinator.cancelResponderLadder()
        coordinator.cancelBatchSubmit()
        (field as? YaverDictationTextField)?.onDictationRecordingDidEnd = nil
        coordinator.field = nil
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: YaverDictationField
        weak var field: UITextField?
        private var responderTask: Task<Void, Never>?
        private var batchSubmitTask: Task<Void, Never>?
        private var endCallbackSent = false
        // Zero means "do not open automatically". Composer routes explicitly
        // bump to 1 after attachment; reply fields keep zero so navigating to
        // task detail matches IMG_6382 and never resurrects the keyboard.
        var lastEditingRequest = 0

        init(_ parent: YaverDictationField) {
            self.parent = parent
        }

        /// First responder must be claimed AFTER the hosting view is attached
        /// to the window — during a sheet transition, or before a field is
        /// installed, the request is silently dropped. The ladder retries over
        /// the sheet/keyboard animation window (measured ~0.5 s on a real TV)
        /// and stops at the first success.
        func requestFirstResponder() {
            cancelResponderLadder()
            InputStateReporter.shared.noteFocusRequest()
            let steps: [Double] = [0, 0.05, 0.1, 0.25, 0.5, 0.9]
            let task = Task { @MainActor [weak self] in
                for (index, delay) in steps.enumerated() {
                    if index > 0 {
                        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    }
                    guard !Task.isCancelled else { return }
                    guard let field = self?.field else { continue }
                    let inWindow = field.window != nil
                    if !field.isFirstResponder {
                        let ok = field.becomeFirstResponder()
                        InputStateReporter.shared.responderAttempts += 1
                        InputStateReporter.shared.lastAttemptResult = ok
                    }
                    InputStateReporter.shared.responder = field.isFirstResponder
                    if field.isFirstResponder {
                        return
                    }
                    if index == steps.count - 1 {
                        InputStateReporter.shared.lastAttemptResult = inWindow
                    }
                }
            }
            responderTask = task
        }

        func cancelResponderLadder() {
            responderTask?.cancel()
            responderTask = nil
        }

        func cancelBatchSubmit() {
            batchSubmitTask?.cancel()
            batchSubmitTask = nil
        }

        @objc func textDidChange(_ field: UITextField) {
            syncCommittedText(from: field)
        }

        func textField(
            _ textField: UITextField,
            shouldChangeCharactersIn range: NSRange,
            replacementString string: String
        ) -> Bool {
            guard parent.autoSubmitBatchInput,
                  string.trimmingCharacters(in: .whitespacesAndNewlines).count > 1 else {
                return true
            }
            // Physical iPhone Remote fallback: Continuity Keyboard does not
            // expose tvOS dictation callbacks, but its blue Done commits the
            // recognized phrase as one batch replacement. Coalesce additive
            // chunks long enough to avoid the former first-two-characters bug.
            cancelBatchSubmit()
            batchSubmitTask = Task { @MainActor [weak self, weak textField] in
                try? await Task.sleep(nanoseconds: 900_000_000)
                guard !Task.isCancelled, let self, let textField else { return }
                self.syncCommittedText(from: textField)
                self.notifyEndEditingOnce()
            }
            return true
        }

        func dictationRecordingEnded() {
            guard parent.autoSubmitBatchInput else { return }
            cancelBatchSubmit()
            DispatchQueue.main.async { [weak self] in
                guard let self, let field = self.field else { return }
                self.syncCommittedText(from: field)
                self.notifyEndEditingOnce()
            }
        }

        func textFieldDidBeginEditing(_ field: UITextField) {
            // The field is now the active tvOS text-input responder — the only
            // state in which the Siri Remote mic dictates into it.
            endCallbackSent = false
            InputStateReporter.shared.noteEditingBegan()
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            // Menu closed the keyboard or the return key resigned. The field
            // keeps SwiftUI focus (focused-but-not-editing is the correct tvOS
            // state): Select on the focused field re-opens the keyboard, and
            // navigation away clears focus through the normal focus engine.
            // Do NOT clear SwiftUI focus here — dropping it left Up/Down unable
            // to reach the surrounding controls after the keyboard closed.
            syncCommittedText(from: field)
            InputStateReporter.shared.noteEditingEnded()
            notifyEndEditingOnce()
        }

        func textFieldShouldEndEditing(_ field: UITextField) -> Bool {
            // Apple TV Remote's blue tick can ask the field to end editing
            // without reaching textFieldShouldReturn or, on some releases,
            // textFieldDidEndEditing. Forward the event at this earlier
            // delegate boundary too; callers guard duplicate submits.
            syncCommittedText(from: field)
            notifyEndEditingOnce()
            return true
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            // Remote dictation may install the final phrase directly on the
            // UIKit field without first sending editingChanged. Commit that
            // value before notifying SwiftUI; otherwise Done creates an empty
            // or stale task even though the keyboard visibly contains text.
            syncCommittedText(from: field)
            DispatchQueue.main.async { [weak self] in self?.parent.onSubmit() }
            // The keyboard-only New vibe host stays first responder while the
            // task POST runs, so no app-owned loading widget can flash between
            // the blue tick and Task Detail. Dismantling that host after the
            // returned task navigation closes the keyboard atomically. Other
            // chat fields retain the ordinary Return-to-resign behavior.
            if !parent.autoSubmitBatchInput {
                field.resignFirstResponder()
            }
            return true
        }

        private func syncCommittedText(from field: UITextField) {
            let value = field.text ?? ""
            parent.text = value
            InputStateReporter.shared.lastTextChange = value
            InputStateReporter.shared.lastTextChangeAt = Date()
        }

        private func notifyEndEditingOnce() {
            guard !endCallbackSent else { return }
            endCallbackSent = true
            DispatchQueue.main.async { [weak self] in self?.parent.onEndEditing() }
        }

        deinit {
            responderTask?.cancel()
            batchSubmitTask?.cancel()
        }
    }
}

/// UIKit exposes a real dictation-completed boundary when dictation runs on
/// tvOS itself. iPhone Continuity Keyboard currently uses the batch-replacement
/// fallback above, but keeping both operations wired prevents OS-version drift.
private final class YaverDictationTextField: UITextField {
    var onDictationRecordingDidEnd: (() -> Void)?

    override func dictationRecordingDidEnd() {
        super.dictationRecordingDidEnd()
        onDictationRecordingDidEnd?()
    }
}
