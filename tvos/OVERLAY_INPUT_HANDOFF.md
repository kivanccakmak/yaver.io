# tvOS Vibe overlay input handoff

## Requested behavior

In Interactive Vibing, the left-side WebRTC preview is a remote mouse/scroll
overlay.

- While that overlay is active, Up, Down, Left, and Right must control the
  remote app. None of those directions may move SwiftUI focus into the Vibe
  controls or otherwise leave the overlay.
- Back/Menu is the only overlay exit. Its first press must leave overlay mode
  and put focus back in the Vibe widget.
- Once overlay mode is off, Back/Menu is normal route navigation and returns
  from Vibing to the dashboard.

## What changed

`YaverTV/Views/RemoteRuntimeWebRTCView.swift` now has an explicit
`TVOverlayInputState` reducer (`overlayInput`), separate from `streamFocused`
(SwiftUI focus).

- Entering the WebRTC hit target or Mouse mode enables `overlayMode`.
- The WebRTC target is a custom tvOS `UIButton` which consumes directional
  presses at the UIKit boundary, before the default focus engine can highlight
  a Vibe chip. The SwiftUI root handler remains a guarded fallback.
- A per-event move guard ensures an arrow observed by both SwiftUI handlers
  executes exactly one remote move.
- Back/Menu clears overlay state and moves focus to Vibe. A deferred handoff
  guard prevents the same physical Back event from bubbling into a dashboard
  dismissal. A subsequent Back/Menu dismisses the pushed Vibing route.
- The guards are implemented by the Foundation-only
  `TVOverlayInputState` reducer, so duplicate delivery and the two-step Back
  contract are testable without a simulator or live box.

The previous right-edge escape behavior is gone; right at the cursor's edge is
still a remote pointer command.

## Verification added

`YaverTVUITests/TVWebPreviewLoopTests.swift` now verifies the simulator flow:

1. Enter the remote-app overlay from the Vibe prompt.
2. Press Right repeatedly through the edge, then Up, Down, Left, and Right.
3. Confirm the overlay remains focused after every directional command and
   that its focus-loss counter remains exactly zero.
4. Press Back/Menu once and confirm focus returns to the Vibe prompt.
5. Press Back/Menu again and confirm the dashboard's Vibing tile is visible.

## Local checks performed

```sh
cd tvos
xcodegen generate
xcodebuild -project YaverTV.xcodeproj -scheme YaverTV \
  -sdk appletvsimulator \
  -destination 'generic/platform=tvOS Simulator' \
  build-for-testing CODE_SIGNING_ALLOWED=NO \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES -quiet
cd ..
swiftc -O -parse-as-library \
  tvos/YaverTV/TVOverlayInputState.swift \
  tvos/Checks/TVOverlayInputStateChecks.swift \
  -o /tmp/yaver-tv-overlay-checks && /tmp/yaver-tv-overlay-checks
git diff --check
```

The headless reducer reports `PASS: 9 tvOS overlay input checks`. The duplicate
move guard was then deliberately disabled: the check failed with `the parent
handler cannot duplicate the same arrow`; restoring the guard returned all
nine checks to green. This proves the guard is load-bearing, not a false green.

The simulator UI arc is compiled into `TVWebPreviewLoopTests`. Its media/input
portion still requires the configured real box/token environment; absent that
fixture, physical installation plus the Siri Remote arc is the remaining
closed-loop check, not an inferred pass.

`TVOverlayInputStateTests` also passed all four reducer cases on tvOS Simulator
26.5. The first physical build proved that Right stayed in overlay mode and
Back worked, but also revealed a transient DeepSeek-chip blink and focus click
which the final-focus assertion missed. The UIKit press capture and zero-loss
assertion are the resulting product/test hardening.

After explicit authorization, the corrected second source built with automatic
development signing, installed from `Debug-appletvos/Yaver.app` on the paired
Apple TV, and launched as `io.yaver.mobile` at 11:20 local time. The remaining
pixel/input verdict is the physical repeated-arrow and Back replay on that exact
build.

## Source of truth

This note is a handoff, not an API contract. Verify current behavior in
`YaverTV/Views/RemoteRuntimeWebRTCView.swift` and its UI test before extending
the input routing.
