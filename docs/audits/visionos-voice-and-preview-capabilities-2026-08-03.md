# visionOS — voice (STT/TTS) as the data path, and preview capabilities

**Date:** 2026-08-03
**Status:** AUDIT. Every availability claim below was MEASURED on this Mac, not
inferred — the method is shown so the next reader can re-run it rather than
trust it.
**Question:** in AR/VR the user has no keyboard. Can Yaver's loop run on voice,
what does that do to the data path, and what preview options should visionOS
actually be offered?

---

## 0. Verdict up front

**visionOS is the surface that needs voice most and is the only Apple surface
Yaver ships with none of it.** Its single input is a `TextField` — a floating
virtual keyboard in a headset — and it has no spoken output at all. tvOS, which
needs voice *less* (it has a remote and a big screen), has TTS.

Both APIs are available. This is not a platform limitation; it is an unwritten
feature.

---

## 1. What is actually on the surface today (measured)

`visionos/` is **five** Swift files:

```
YaverVisionApp.swift
Views/VisionSignInView.swift
Views/VisionDashboardView.swift
Views/VisionSessionView.swift
YaverVisionUITests/VisionDashboardUITests.swift
```

Input, `VisionSessionView.swift:90`:

```swift
TextField("Ask the active coding session...", text: $prompt, axis: .vertical)
    .onSubmit { Task { await sendPrompt() } }
```

There is no `Speech.swift`, no `AVSpeechSynthesizer`, no `SFSpeechRecognizer`
anywhere under `visionos/`.

Compare the sibling surfaces:

| Surface | Speech OUT (TTS) | Speech IN (STT) | Primary input today |
|---|---|---|---|
| **visionOS** | ❌ none | ❌ none | virtual keyboard |
| tvOS | ✅ `tvos/YaverTV/Speech.swift` | ❌ | Siri Remote |
| watchOS | ✅ `watch/YaverWatch/Speech.swift` | ❌ | dictation via system |
| mobile / car / glass (RN) | ✅ `voice/adapters/deviceTts.ts` | ✅ `whisperCapture.ts` | voice core |

The RN family has a whole conversation engine — `VoiceConversationCore`,
`endpointer.ts`, `completenessJudge.ts`, barge-in, semantic submit
(`docs/architecture/VOICE_CONVERSATION.md`). **The native surfaces have a
hand-rolled TTS shim and nothing else**, because native Swift cannot import
`mobile/src/lib/*`. That is the cross-surface drift CLAUDE.md already names,
and voice is currently its worst instance.

---

## 2. Availability — MEASURED, not inferred

The inventory is ambiguous here, which is exactly why it was probed.

**Step 1 — framework present in the visionOS SDK?**

```
$ xcrun --sdk xros --show-sdk-path
/Applications/…/XROS.platform/Developer/SDKs/XROS26.2.sdk
  Speech.framework:        PRESENT
  AVFoundation.framework:  PRESENT
```

**Step 2 — but the header says otherwise.** `SFSpeechRecognizer.h`, *inside the
xrOS SDK*, is annotated:

```objc
API_AVAILABLE(ios(10.0), macos(10.15), tvos(18))
```

No `visionos()` clause. Read literally, that says "not on visionOS" — and a
framework being present in an SDK proves nothing about a class being callable
(the whole "inventory says yes, operation says no" family).

**Step 3 — so attempt the operation.** A typecheck is the cheapest execution
that settles it:

```bash
cat > /tmp/sttprobe.swift <<'EOF'
import Speech
import AVFoundation
func probe() {
    _ = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    _ = SFSpeechAudioBufferRecognitionRequest()
    let s = AVSpeechSynthesizer()
    s.speak(AVSpeechUtterance(string: "hello"))
}
EOF
xcrun swiftc -typecheck -sdk "$(xcrun --sdk xros --show-sdk-path)" \
  -target arm64-apple-xros2.0 /tmp/sttprobe.swift
```

**Result: compiles clean.** Both STT and TTS are available on visionOS. The
missing `visionos()` clause is annotation noise (visionOS inherits iOS
availability), and the header alone would have produced the wrong answer in the
*conservative* direction — "we can't, the SDK says so" — which is the kind of
wrong that quietly cancels a feature.

⚠️ A typecheck proves the API is **callable**. It does not prove microphone
capture works in an immersive space, nor what the on-device recognition quality
is. Those need a device or simulator run — see §6.

---

## 3. What voice does to the DATA PATH (the part that actually matters)

This is where an AR/VR voice loop stops being a UI question. Audio is the most
sensitive payload Yaver would ever move, and the privacy contract is explicit:
Convex stores identity, discovery and session bookkeeping ONLY — task input
prompts and outputs are forbidden there (`convex_privacy_test.go`).

**A voice prompt IS a task input prompt.** So:

| Stage | Where it may go | Where it must NOT go |
|---|---|---|
| raw audio | the headset, in memory | never leaves the device |
| transcript | headset → the user's OWN box (direct/LAN/relay) | never Convex |
| runner output text | the user's box → headset | never Convex |
| spoken output | synthesised ON the headset | never a cloud TTS |

Three rules follow, and each has a way to get it wrong:

1. **STT on-device, always.** `SFSpeechRecognizer.supportsOnDeviceRecognition`
   exists precisely so audio never leaves. Apple's recogniser will happily fall
   back to SERVER recognition if you do not set
   `requiresOnDeviceRecognition = true` — meaning a user's spoken prompt, which
   may contain code, secrets or customer names, is shipped to Apple. That is a
   silent violation of the privacy contract with no error and no log line.
   **This must be a hard-coded `true`, not a setting**, and it deserves a guard.
   Note the header above: `supportsOnDeviceRecognition` is annotated
   `ios(13), tvos(18)` — whether it reports true on a given headset/locale is
   the §6 device check, and if it is false the honest product answer is to
   REFUSE and say why, not to fall back to the server.

2. **The transcript rides the existing lane, not a new one.** visionOS already
   talks to the box for `sendPrompt()`. Voice changes the *source* of the
   string, not its destination. No new transport, no new endpoint, nothing new
   to secure — and anything that proposes one should be rejected on that basis.

3. **TTS is local synthesis of text the box already sent.** No audio comes back
   over the wire; `AVSpeechSynthesizer` speaks a string that was already
   travelling. So the reverse path adds no new data exposure at all.

**Net: a correctly-built visionOS voice loop moves NO new data off the device.**
Audio never leaves, and the transcript is a prompt the surface was already
going to send. The only way to break that is to let the recogniser fall back to
Apple's servers — which is one unset boolean.

---

## 4. Preview capabilities for visionOS

`DetectProjectPreviewCapabilities` answers per PROJECT (framework detected from
disk) and returns options every surface renders. It does not currently take the
**surface** into account, and for visionOS three of the options are wrong:

| Option | visionOS reality |
|---|---|
| `compile-hermes` / `open-native` | **impossible.** A Hermes bundle is JS bytecode for a React Native container. The visionOS app is SwiftUI — there is no RN runtime to load it into. Per the file's own hard rule it must be ABSENT, not greyed out. |
| `dev-server` (Browser Reload) | **possible** — visionOS has WKWebView, so a web target can render in-headset. |
| `remote-runtime` (Stream over WebRTC) | **the primary** — pixels rendered on the box and streamed. Best fit for a headset that is a viewing surface, not a build host. |
| `wire-push` | **impossible** — no cable install path to a headset. |

Today visionOS gets whatever the project-level answer is, so it can be offered
Hermes for an Expo project — a button that cannot do anything on that surface.
That is the exact defect the capability layer was created to remove, just on an
axis it does not model yet.

**Recommendation:** add an optional `surface` to
`DetectProjectPreviewCapabilities` and filter there — NOT in the visionOS app.
A UI-only rule is not a rule (the file says so): the endpoint would still serve
Hermes to a caller that did not filter.

---

## 5. What the closed loop can and cannot say about this

`e2e/native-headless-vibe.mjs vision` reaches **PIXELS** by sampling a frame the
box renders at 1280x720. It states its own scope on every run, and that scope
explicitly does NOT include the native app. So:

- ✅ proven: the runner edits, the dev server rebuilds, the render pipeline
  produces the right pixels at headset geometry.
- ❌ NOT proven, and not provable this way: that `VisionSessionView` renders,
  that a prompt can be spoken, that anything is audible.

A voice loop needs a different terminal signal — the audio equivalent of
PIXELS. The honest one is **round-trip text**: speak a known phrase into the
simulator, assert the transcript reaches the box as a task, assert the reply is
handed to the synthesiser. That is checkable without measuring sound, and it
fails loudly when the recogniser is not running.

---

## 6. What is NOT settled here

Stated plainly so nothing above is read as more certain than it is:

1. **Microphone capture in an immersive space** — a typecheck says the API
   exists; it does not say `AVAudioEngine` input behaves in a shared vs full
   space, nor what the permission flow looks like in-headset.
2. **`supportsOnDeviceRecognition` on a real headset**, per locale. If it is
   false, §3.1 says refuse rather than fall back — but which locales are
   affected is a device measurement.
3. **Whether the RN voice core can be reused at all.** It is TypeScript and the
   visionOS app is SwiftUI. Either the endpointing/completeness logic is ported
   (and drifts — the wake ladder's percentages already disagree across three
   copies whose comments claim they match), or the surface stays "dumb mic +
   send" and the smart part lives on the box. **The second is probably right**
   and would also fix tvOS/watchOS, whose Speech.swift shims have none of the
   conversation logic today.

---

## 7. Ordered recommendation

1. **`visionos/YaverVision/Speech.swift`** — mirror tvOS's TTS shim. Smallest
   possible change, immediately useful, no data-path change whatsoever.
2. **Dictation input with `requiresOnDeviceRecognition = true`**, plus a guard
   asserting that flag is set — the one line that separates "no new data
   leaves" from "spoken prompts go to Apple".
3. **`surface` parameter on the capability layer**, so visionOS stops being
   offered Hermes and `wire-push`.
4. **Decide where the conversation logic lives** (§6.3) before porting anything.
   If it goes on the box, all three native surfaces get it at once and none of
   them can drift.
