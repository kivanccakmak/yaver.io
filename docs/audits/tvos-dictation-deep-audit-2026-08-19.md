# tvOS Dictation / STT Deep Audit

Date: 2026-08-19  
Surface: Yaver tvOS app on a physical Apple TV (`AppleTV14,1`, tvOS 26.6)  
Device: `Living Room (2)`  
Purpose: give DeepSeek a precise handoff for fixing Siri Remote and iPhone Apple TV Remote text input.

## Objective

Yaver tvOS should support the same practical voice-input experience users get in apps such as YouTube:

- Open Yaver Chat / New Vibe / Deep Audit / Vibe chat.
- Focus a native text-input surface.
- Hold the Siri Remote voice button and dictate into that field.
- Also support the iPhone Apple TV Remote keyboard/dictation path.
- Send the resulting text as a normal Yaver task/chat prompt.
- Work for remote-box tasks and optional boxless DeepSeek chat/audit.
- Never require a microphone API key, expose audio to a webpage, or break the remote-box path.

Rendering and coding authority remain separate:

- Selected remote box: OpenCode/runner, Git, shell, builds, rendering, and deploys.
- No remote box: optional DeepSeek chat/deep-audit only.
- tvOS web/WebRTC surfaces may display and interact with a remote runtime, but the webpage itself must not be expected to receive the Siri Remote microphone.

## What is actually implemented

### Native tvOS input path

The app uses native SwiftUI `TextField` controls rather than a web input or custom microphone API:

- `tvos/YaverTV/Views/TaskComposerView.swift`
- `tvos/YaverTV/Views/VibeTurnPanel.swift`
- `tvos/YaverTV/Views/BoxlessCodeView.swift`
- `tvos/YaverTV/Views/SessionView.swift`
- `tvos/YaverTV/Views/TaskDetailView.swift`

tvOS has no app-level Siri Remote microphone callback and no usable `SFSpeechRecognizer`/recording path for this product lane. The intended path is system dictation into a focused native text field. TTS is separate and uses `AVSpeechSynthesizer` through `tvos/YaverTV/Speech.swift`.

### Focus work already landed

The following were shipped in the latest source and included in the local development build:

- New Vibe prompt changed away from the unreliable multiline-axis input.
- Explicit delayed focus is requested on composer appearance.
- Vibe prompt focus follows panel expansion and focus requests.
- Boxless prompt also uses native single-line input and delayed focus.
- Vibe conversation scroll handling no longer intercepts all directional movement.
- tvOS render surface has a real SwiftUI focusable/button hit target for Siri Remote Select and movement.

Latest pushed source commits:

- `1cc2e93b6` — tvOS vibing controls, focus, render hit target, account settings.
- `a4acbeeec` — tvOS dictation field hardening and local-device provisioning repair.

The latest source changed the New Vibe field to strict `.lineLimit(1)` because the prior source still reserved three lines even after removing the multiline axis. A multiline input can lose tvOS dictation routing.

### Direct Apple TV development install

The physical Apple TV was successfully paired and registered for development.

- CoreDevice pairing identifier: `149C092A-85D6-5F58-B791-3685AEAB166B`
- Apple Developer hardware UDID: `00008110-00063D983A7A801E`
- Product: `AppleTV14,1`
- tvOS: `26.6`
- Apple Developer device name: `Living Room 2`

The direct development lane was repaired to authenticate automatic signing and register devices:

```bash
scripts/deploy-tvos.sh --device 149C092A-85D6-5F58-B791-3685AEAB166B
```

The app built with the Apple Development identity and `tvOS Team Provisioning Profile: io.yaver.mobile`, installed successfully, and launched successfully on the Apple TV. This is separate from TestFlight.

The TestFlight archive also completed successfully as tvOS build 291, but build 291 predates the final strict one-line source correction and does not prove the microphone path.

## What is not working

Observed on the physical Apple TV:

- Yaver launches successfully.
- The microphone/dictation path still does not insert speech into the Yaver prompt.
- The user reports that the same Apple TV / remote works for YouTube voice input.
- Therefore the earlier hypothesis that the remote is necessarily a non-Siri/Search-only remote is not sufficient and should not be treated as the diagnosis.

Important distinction:

- A microphone icon inside an embedded GitHub/project webpage cannot receive the Siri Remote microphone directly.
- The native Yaver overlay must capture dictation and pass the resulting string into the task/chat layer.
- The native Yaver prompt itself should work if it becomes the active tvOS text responder.

## Corrected diagnosis

Because YouTube works with the same remote, investigate Yaver’s focus/responder lifecycle first:

1. `@FocusState` may be set in SwiftUI state while the underlying tvOS text control is not actually first responder.
2. `.defaultFocus($promptFocused, true)` plus `DispatchQueue.main.async` may run before a sheet/navigation transition has installed the field.
3. The prompt may visually appear but not be the active text-input surface when the user holds Siri.
4. A surrounding `ScrollView`, sheet, WebRTC surface, or focusable overlay may steal focus immediately after appearance.
5. The prompt may be presented in a route that has no active system keyboard/input session.
6. The app currently has no explicit diagnostic showing “native text responder active” versus merely “focus state requested.”
7. The New Vibe route, Vibe turn panel, Boxless Code route, Session route, and web/runtime overlay may have subtly different focus behavior.

Do not solve this by adding a fake microphone button. tvOS does not expose the physical Siri Remote microphone press to app code. The reliable solution is to make the native text responder active and visible, then consume the text binding.

## Required investigation

DeepSeek should inspect and instrument the real native input lifecycle, without logging audio, credentials, or prompt contents unnecessarily:

### A. Prove the system capability outside Yaver

- On the same Apple TV and remote, confirm YouTube dictation works in a visible text field.
- Confirm Apple TV Settings language/region/Siri configuration is not disabling dictation.
- Confirm the iPhone Apple TV Remote can bring up the tvOS keyboard and insert text.
- Record which exact remote button is used and whether the tvOS keyboard is visibly active.

### B. Prove Yaver focus, not just SwiftUI state

Add temporary or development-only diagnostics that report:

- route name (`task-composer`, `vibe-turn`, `boxless`, `session`, `task-detail`);
- requested focus state;
- actual focus transition callbacks;
- scene activation/phase;
- whether the text field became first responder / active input session;
- whether the bound text changed after a keyboard or dictation action;
- whether focus was stolen by another view after appearance.

Never log the raw DeepSeek key, bearer token, Git credential, audio, or full user prompt.

### C. Test stronger responder strategies

Compare, on the physical TV:

- native SwiftUI `TextField` with delayed focus after sheet presentation;
- explicit user Select on the field followed by dictation;
- a small tvOS UIKit `UITextField` bridge that calls `becomeFirstResponder()` after the view is attached;
- a visible focus state/border proving the field is the active input target;
- a shared reusable native dictation composer used by every tvOS route.

The UIKit bridge must remain a text-input bridge only. It must not request raw microphone permission or implement a second speech-recognition pipeline.

### D. Exercise both input sources

The acceptance matrix is:

| Route | Siri Remote dictation | iPhone Apple TV Remote text/dictation | Box required |
|---|---:|---:|---:|
| New Vibe / Deep Audit | required | required | task mode determines |
| Vibe turn chat | required | required | remote box for coding turn |
| Boxless DeepSeek Code | required | required | no |
| Session prompt | required | required | runner/session |
| Task reply | required | required | task runner |
| Embedded GitHub/project webpage input | not direct | not direct | web content must use native Yaver overlay |

### E. Failure plumbing

If dictation cannot be activated, do not show an infinite spinner or imply that speech was captured. Show a named state such as:

`TV_INPUT_NOT_ACTIVE — Select the native prompt once, then hold the Siri button. Use iPhone Apple TV Remote for text entry if the system keyboard does not appear.`

The route-to-fix must be visible on tvOS. The app should distinguish:

- `tvOS native text input active`;
- `tvOS native text input not active`;
- `system dictation unavailable / remote search mode`;
- `web input requires native Yaver overlay`.

## What must remain unchanged

- Remote-box-first remains the default task/coding connection.
- Boxless is optional and task/chat/audit-only.
- No API key is placed in logs, URLs, source, screenshots, or browser pages.
- No raw microphone stream is sent to DeepSeek or a remote box.
- Remote rendering remains gated on a real runtime.
- Local direct Apple TV install is a development/testing lane and does not replace TestFlight.
- Third-party tvOS projects should use the same native dictation/input contract when Yaver overlays their task/chat controls.

## Current conclusion

The build/install/signing problem is solved. The remaining issue is a live tvOS input-responder defect or an unverified system dictation condition. Since YouTube works with the same remote, do not close the incident as “remote lacks Siri.” Prove the active responder and text-change path on the physical Apple TV, then consolidate all tvOS task/chat/audit inputs behind one native dictation composer.

## Resolution (same day, simulator-verified)

The responder defect was confirmed and fixed in source; the physical-TV mic test
is deferred until the Apple TV is free (the direct-device lane
`scripts/deploy-tvos.sh --device 149C092A-85D6-5F58-B791-3685AEAB166B` is ready).

**Confirmed by measurement (tvOS 26.5 simulator, accessibility dump):** the
field was focus-ring-selected (`Focused`) while the UIKit editing session was
never active (`responder: false, kb: false`) — precisely the “visually appears
but is not the active text-input surface” case. Root cause: SwiftUI
`@FocusState` + `.focused()` moves the tvOS focus ring but does not reliably
make the underlying field the first-responder that Siri Remote dictation routes
into. On HEAD the composer’s keyboard did not even appear reliably in the
simulator (all four `TVChatNavigationTests` failed at the keyboard assertion).

**Fix shipped:**
- New shared `YaverDictationField` (`tvos/YaverTV/Views/YaverDictationField.swift`):
  a `UITextField` bridge that claims first responder via a bounded retry ladder
  (covers sheet-transition timing) **once per explicit `editingRequestID`
  bump**, not reactively. Focus stays in SwiftUI (`.focused`/`@FocusState`); the
  tvOS focus engine dismisses the keyboard on navigation. This separation is the
  key: re-asserting focus on a field must not reopen the keyboard (that made
  Menu unable to close it), and becoming first responder must not depend on a
  focus binding (that left the field ring-only, `responderAttempts: 0`).
- All five routes (`task-composer`, `vibe-turn`, `boxless`, `session`,
  `task-detail`) now use it. The Vibe prompt lost its `focusEffectDisabled` and
  gained a visible armed-state border.
- Failure plumbing (`tvos/YaverTV/Views/TVInputStatus.swift`):
  `TV_INPUT_NOT_ACTIVE` with a route-to-fix line under any prompt whose
  responder never engaged; a Debug-build input HUD reports
  route/focusReq/responder/keyboard/attempts/begin/end for the physical-TV pass.
- Simulator regression: `TVChatNavigationTests.testComposerPromptIsActiveTextResponder`
  types into the focused prompt and asserts the text lands (the simulator-valid
  proxy for dictation routing), then asserts Menu closes the keyboard and Up
  still reaches the header.

**Simulator results:** keyboard now appears on route open (`attempts: 1`, no
flap), typing lands (`hello couch`), Menu closes the keyboard and it stays
closed, and Up reaches the ellipsis. 3/3 dictation navigation tests pass plus
the new responder test. One pre-existing, unrelated failure remains
(`testMenuReturnsFromDevicesSheetAndVisibleBackExists`, Devices sheet) — it
fails identically on HEAD baseline and touches no text input.

**Still hardware-only:** the Siri Remote mic itself. The responder state the mic
dictates through is proven in the simulator; the hold-mic→insert step needs the
physical Apple TV.

**Follow-up fixes in the same pass (simulator-verified):**

- **Dashboard “only 4 clickable boxes”** — measured: the tile rail is a
  full-width strip at the bottom, but the only focusable targets above (Switch
  button, profile menu) sat at the far right, so the tvOS focus engine could not
  move Up from the left/centre tiles — no horizontally-overlapping target
  existed. The whole machine card is now a full-width focusable target (tap =
  switch machines) with `defaultFocus(.chat)` restored at scope level, so the
  chain Chat → card → profile is reachable and Chat still owns initial focus.
- **Vibing pointer right-move** — while media was still connecting,
  `!runtime.hasMedia` was true, so the FIRST Right press bounced focus to Chat
  and the pointer could never move right. The right-edge escape to Chat now
  requires real pixels on screen.
- **Vibing closed-loop test** was stale after the stream hit-target became a
  Button (label “Activate remote app”); the “Pointer” expectation was updated.
- **Devices-sheet UI test** was navigating to Settings (the rail lost Projects);
  corrected to reach Devices. Note: opening Devices hits the Convex registry, so
  this test still requires a real account token (with the fake audit token the
  401 signs the app out) — environment-gated, fails identically on HEAD.

**TestFlight:** the dictation fix uploaded first as tvOS build 2; the follow-up
fixes above deploy as build 3.
