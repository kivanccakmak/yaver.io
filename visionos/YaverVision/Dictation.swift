// Dictation.swift — on-device speech-to-text for the visionOS prompt field.
//
// Split from Speech.swift because that file declares `enum Speech` (named for
// parity with tvOS) and a type shadowing an imported module makes
// `SFSpeechRecognizer` silently unresolvable. `swiftc -typecheck` caught it
// before it shipped; keeping the two concerns in separate files makes the
// collision impossible rather than merely fixed.
//
// The privacy rule, the availability measurement, and why this is a plain
// transcriber rather than a conversation engine are all documented below.

import Foundation

#if canImport(AVFoundation)
import AVFoundation
#endif
#if canImport(Speech)
import Speech
#endif

enum SpeechError: LocalizedError {
    case unavailable(String)
    case notPermitted(String)
    case onDeviceUnavailable

    var errorDescription: String? {
        switch self {
        case .unavailable(let why): return why
        case .notPermitted(let why): return why
        case .onDeviceUnavailable:
            // Name the remedy, not the symptom.
            return "On-device speech recognition is not available for this language on this headset. "
                + "Yaver will not dictate through Apple's servers, because a spoken prompt is a task "
                + "prompt and those never leave your devices. Download the offline language in "
                + "Settings › General › Keyboard › Dictation, or type the prompt instead."
        }
    }
}

// ─── Listening (STT) ────────────────────────────────────────────────────────

#if canImport(Speech) && canImport(AVFoundation)

/// On-device dictation for the prompt field.
///
/// Deliberately a plain transcriber, NOT a conversation engine. The RN surfaces
/// have endpointing, semantic submit and barge-in
/// (mobile/src/lib/voice/, docs/architecture/VOICE_CONVERSATION.md) and that
/// logic is TypeScript a SwiftUI app cannot import. Porting it here would
/// create a fourth copy to drift — the wake ladder's percentages already
/// disagree across three copies whose comments claim they match. So this
/// surface stays "dumb mic + text", the user presses send, and the question of
/// where conversation logic should live is left open in the audit (§6.3) rather
/// than answered by accident here.
@MainActor
final class DictationSession: ObservableObject {
    @Published private(set) var transcript = ""
    @Published private(set) var listening = false
    @Published private(set) var error: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    /// True when this headset can transcribe WITHOUT sending audio anywhere.
    /// The UI uses it to hide the mic rather than offer a button that will
    /// refuse — an offered control that cannot work is worse than none.
    var canDictatePrivately: Bool {
        recognizer?.supportsOnDeviceRecognition == true
    }

    /// THE GUARD. Called on the request actually submitted, not on a copy.
    ///
    /// Separate from the assignment on purpose: setting the flag where the
    /// request is created and checking it where the request is used is what
    /// makes this survive a future refactor that builds the request elsewhere.
    static func assertOnDeviceOnly(_ req: SFSpeechAudioBufferRecognitionRequest) throws {
        guard req.requiresOnDeviceRecognition else {
            throw SpeechError.notPermitted(
                "Refusing to dictate: the recognition request was not marked on-device, which would "
                + "send your spoken prompt to Apple's servers. This is a bug — please report it."
            )
        }
    }

    func start() async {
        guard !listening else { return }
        error = nil
        transcript = ""

        guard let recognizer, recognizer.isAvailable else {
            error = SpeechError.unavailable("Speech recognition is unavailable on this device right now.").localizedDescription
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            error = SpeechError.onDeviceUnavailable.localizedDescription
            return
        }
        guard await Self.requestAuthorization() else {
            error = SpeechError.notPermitted(
                "Yaver needs Speech Recognition and Microphone permission to dictate. Enable them in Settings › Privacy."
            ).localizedDescription
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Not a preference. See the file header.
        req.requiresOnDeviceRecognition = true
        do {
            try Self.assertOnDeviceOnly(req)
        } catch {
            self.error = error.localizedDescription
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            self.error = "Could not start the microphone: \(error.localizedDescription)"
            cleanup()
            return
        }

        request = req
        listening = true
        task = recognizer.recognitionTask(with: req) { [weak self] result, err in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.stop() }
                }
                if err != nil {
                    self.error = err?.localizedDescription
                    self.stop()
                }
            }
        }
    }

    func stop() {
        guard listening || task != nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        cleanup()
    }

    private func cleanup() {
        request = nil
        task = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func requestAuthorization() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { c.resume(returning: $0) }
        }
    }
}

#endif
