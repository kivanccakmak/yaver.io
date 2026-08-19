// Speech.swift — visionOS's voice channel, in and out.
//
// ─── Why this surface needs it most ────────────────────────────────────────
//
// In a headset the user has no keyboard. visionOS's only input until now was a
// SwiftUI TextField, which means the floating virtual keyboard — the worst
// input method the platform offers, for the longest strings Yaver asks anyone
// to type. Meanwhile tvOS and watchOS, which need voice LESS (a remote, a
// wrist), both already ship a Speech.swift. visionOS had none.
//
// ─── Availability was MEASURED, and the inventory disagrees ────────────────
//
// This matters enough to write down, because reading the SDK would have
// produced the WRONG answer in the direction that quietly cancels features.
//
//   Speech.framework IS present in the xrOS SDK. But SFSpeechRecognizer.h,
//   inside that same SDK, is annotated:
//
//       API_AVAILABLE(ios(10.0), macos(10.15), tvos(18))
//
//   — no visionos() clause. Read literally: "not on visionOS."
//
// So the operation was attempted instead of trusting the declaration
// (2026-08-03):
//
//   xcrun swiftc -typecheck -sdk "$(xcrun --sdk xros --show-sdk-path)" \
//     -target arm64-apple-xros2.0 probe.swift
//
// referencing SFSpeechRecognizer, SFSpeechAudioBufferRecognitionRequest and
// AVSpeechSynthesizer: COMPILES CLEAN. Both APIs are available; visionOS
// inherits iOS availability and the missing clause is annotation noise.
// Full working: docs/audits/visionos-voice-and-preview-capabilities-2026-08-03.md
//
// ─── THE PRIVACY RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────
//
// A spoken prompt IS a task input prompt, and task input prompts are forbidden
// from leaving the user's own devices (the Convex privacy contract, enforced by
// convex_privacy_test.go). Apple's recogniser will happily satisfy a request by
// streaming audio to APPLE'S SERVERS unless you tell it not to — silently, with
// no error and no log line. A user dictating a prompt that contains code,
// credentials or a customer's name would have that audio leave the device, and
// nothing anywhere would say so.
//
// `requiresOnDeviceRecognition = true` is therefore NOT a preference and NOT a
// setting. It is hard-coded, and `assertOnDeviceOnly` re-checks it on the
// request that is actually submitted, because the field being set in one place
// and the request being built in another is exactly how this kind of guard
// rots. If on-device recognition is unavailable, this REFUSES and says why —
// falling back to the server would trade a stated limitation for a silent
// breach.
//
// What this adds to the data path: nothing. Audio never leaves the headset, and
// the transcript is a string VisionSessionView was already going to send to the
// user's own box. TTS speaks text the box already returned. No new transport,
// no new endpoint, no new exposure.

// NOTE: this file must NOT `import Speech`. The TTS type below is `enum Speech`
// (named for parity with tvos/YaverTV/Speech.swift), and a type with the same
// name as an imported module shadows it — `SFSpeechRecognizer` then silently
// falls out of scope. Caught by `swiftc -typecheck` before it could ship.
// Dictation therefore lives in its own file, Dictation.swift, which imports the
// framework and declares no colliding name.

import Foundation

#if canImport(AVFoundation)
import AVFoundation
#endif

// ─── Speaking (TTS) ─────────────────────────────────────────────────────────

/// Speak text the box has already returned.
///
/// Mirrors tvos/YaverTV/Speech.swift deliberately: same shape, same rate, so a
/// reader moving between surfaces is not learning two things. Synthesis is
/// local — no audio crosses the wire in either direction.
enum Speech {
    #if canImport(AVFoundation)
    private static let synthesizer = AVSpeechSynthesizer()
    #endif

    /// Speak a sentence. Interrupts anything currently being spoken.
    static func speak(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        #if canImport(AVFoundation)
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.rate = 0.45
        utterance.volume = 1.0
        synthesizer.speak(utterance)
        #endif
    }

    /// Speak the first useful, non-code status line from a runner pane. Keep
    /// this grammar aligned with the companion runner surfaces; visionOS uses
    /// its native VisionSessionView rather than the Siri Remote SessionView.
    static func speakSummary(of pane: String) {
        speak(summarize(pane))
    }

    private static let codePattern = try! NSRegularExpression(
        pattern: #"[{}<>;=]|```|\b(function|const|class|def|import|return)\b|/\w+/"#
    )
    private static let sentencePattern = try! NSRegularExpression(
        pattern: #"^(.{1,120}?[.!?])(\s|$)"#
    )
    private static let markdownPattern = try! NSRegularExpression(
        pattern: "[#*`_~]"
    )

    static func summarize(_ pane: String) -> String {
        for line in pane.split(separator: "\n", omittingEmptySubsequences: true) {
            let value = String(line).trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty else { continue }
            let range = NSRange(value.startIndex..., in: value)
            if codePattern.firstMatch(in: value, range: range) == nil {
                return clampSentence(stripMarkdown(value))
            }
        }
        return "Done."
    }

    private static func clampSentence(_ value: String) -> String {
        let range = NSRange(value.startIndex..., in: value)
        if let match = sentencePattern.firstMatch(in: value, range: range),
           let sentenceRange = Range(match.range(at: 1), in: value) {
            let sentence = String(value[sentenceRange])
            return sentence.count <= 120 ? sentence : String(sentence.prefix(119)) + "…"
        }
        return value.count <= 120 ? value : String(value.prefix(119)) + "…"
    }

    private static func stripMarkdown(_ value: String) -> String {
        let range = NSRange(value.startIndex..., in: value)
        return markdownPattern.stringByReplacingMatches(
            in: value, range: range, withTemplate: ""
        ).trimmingCharacters(in: .whitespaces)
    }

    /// Stop any in-flight speech.
    static func stop() {
        #if canImport(AVFoundation)
        synthesizer.stopSpeaking(at: .immediate)
        #endif
    }

    static var isSpeaking: Bool {
        #if canImport(AVFoundation)
        return synthesizer.isSpeaking
        #else
        return false
        #endif
    }
}
