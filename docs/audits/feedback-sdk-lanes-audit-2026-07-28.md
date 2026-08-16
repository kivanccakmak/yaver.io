# Feedback SDK × lanes × surfaces — deep audit (2026-07-28)

Trigger: yaver-feedback shake did nothing for `sfmg` in the **browser lane on
iOS**. Root cause is not one bug — it's that the feedback trigger/overlay was
never designed per-lane, so each lane fails a different way. This audit maps
every lane, every SDK variant, every UI surface, and specifies the lane-aware
behavior to implement.

## The three lanes (how a third-party app runs inside Yaver)

| Lane | How the app loads | Who should own feedback | file:line |
|---|---|---|---|
| **Hermes** | RN/Expo bundle compiled to HBC, loaded into the native container (`ExpoReactNativeFactory`) | Native container (shake → `showShakeOverlay` at UIWindow level) | `mobile/ios/Yaver/AppDelegate.swift:342,432,492`; gate `hotreload.tsx:77` |
| **Browser** | Web / RN-web / Flutter-web / Next served by the dev server, shown in a **`<Modal presentationStyle="fullScreen">` WebView** | The **injected web SDK inside the WebView DOM** | host `apps.tsx:3174`; shake bridge `apps.tsx:994-1003` + `DevPreview.tsx:255-270` |
| **WebRTC** | Native Swift/Kotlin/Flutter app streamed as `native-webrtc` video | The **viewer** via `launch-feedback` DataChannel | `desktop/agent/remote_runtime.go:709`; mobile `remote-runtime.tsx` |

## SDK variants (which lane each serves)

`sdk/feedback/`: `react-native`, `web`, `flutter`, `kotlin`, `swift`, `unity`,
`browser-extension`, `test-app`.

- **react-native** — Hermes lane. Detects "inside Yaver" via
  `NativeModules.YaverInfo` (`ShakeDetector.ts:13`) and **suppresses** its own
  shake/init so the container owns it (CLAUDE.md suppress-when-inside-Yaver).
- **web** — Browser lane. `YaverFeedback` renders a DOM floating button
  (`createFloatingButton`, `YaverFeedback.ts:2693`, `position:fixed;z-index:99999`)
  + DOM overlay (`:735`), and listens for `yaver-feedback:launch` /
  `__yaverFeedbackLaunch` (`:169-175`). **No lane awareness today.**
- **flutter** — Browser lane (flutter-web) or standalone. `yaver_feedback` on
  pub.dev.
- **kotlin / swift** — native apps (WebRTC lane). Now exist (contra stale
  CLAUDE.md line); viewer-triggered.
- **unity / browser-extension** — niche.

## The iOS browser-lane failure (why shake did nothing)

Three iOS shake paths, ALL dead for the browser lane:

1. **Native CoreMotion → `showShakeOverlay`** (`AppDelegate.swift:457-490,492`) —
   a UIWindow-level overlay that WOULD render over the fullScreen modal, but is
   **started only in `initGuestBridge`** (`:352`) and gated by
   `guard isGuestAppRunning` (`:433`); both are Hermes-only. Dark for WebView.
2. **UIKit `motionEnded` (ShakeDetectingWindow)** — broken by design after the
   bridge swap (RN root consumes the event, `:440-448`) + `isGuestAppRunning`-gated.
3. **JS expo-sensors Accelerometer** (`feedbackTrigger.ts:202-210`) — the only
   one live in the browser lane, but both outputs fail on iOS:
   - WebView inject `yaver-feedback:launch` (`apps.tsx:996`) **dead-letters** —
     sfmg/todo bundle the *RN* SDK, whose web build has no web-SDK listener.
   - root RN `FeedbackOverlay` (`_layout.tsx:168`, an `Animated.View`) is
     **occluded** behind the fullScreen WebView modal.

**Net:** a perfectly-detected shake shows nothing. The mic fix (build 488) does
not touch this — it fixed the Vibing modal, not feedback.

## The fix: DOM-in-WebView beats occlusion

The web SDK's button + overlay are `position:fixed;z-index:99999` DOM nodes
**inside the WebView** — they render on top of the page, inside the WebView,
which fills the modal. Occlusion is irrelevant because they live *inside the
occluding thing*. This is the only occlusion-proof path for the browser lane.

## Lane-aware behavior matrix (to implement)

Yaver injects `window.__yaverLane = "hermes" | "browser" | "webrtc"` (web) and
exposes `YaverInfo.lane` (RN) before SDK init. The SDK branches:

| Lane | SDK behavior |
|---|---|
| hermes | in-app SDK **suppresses** its trigger; container owns shake (current) |
| browser | web SDK **owns** a DRAGGABLE DOM floating icon + overlay (self-hosted) |
| webrtc | SDK **defers** to viewer `launch-feedback`; no in-page icon |

One `YaverFeedback.init()` call in the third-party app (sfmg/todo) → lane-correct
at runtime, no per-lane code in the app.

## UI surfaces that trigger/handle feedback (parity targets)

- mobile `feedbackTrigger.ts` (shake bridge, all lanes), `FeedbackOverlay.tsx`
  (RN overlay), `apps.tsx` + `DevPreview.tsx` (browser inject — DRIFTED, only
  apps.tsx has mic + issues FAB), `remote-runtime.tsx` (webrtc).
- native `AppDelegate.swift` (Hermes shake + overlay), `YaverFeedbackPane.swift`.
- agent `remote_runtime.go:709` (`launch-feedback`), `feedback_to_vibe.go`,
  `/feedback` HTTP.
- web dashboard: feedback lands via agent `/feedback`.

## Implementation plan

1. **web SDK**: add `detectLane()` (`window.__yaverLane` || agent probe);
   make `createFloatingButton` DRAGGABLE (pointer handlers + persisted pos);
   `init()` branches on lane (browser → mount icon; webrtc → no icon; hermes →
   suppress). Bump `yaver-feedback-web`.
2. **RN SDK**: `detectLane()` from `YaverInfo.lane`; keep Hermes suppression;
   expose lane so an RN-web build in the browser lane self-hosts.
3. **injection**: `apps.tsx` + `DevPreview.tsx` inject the built web SDK bundle +
   `window.__yaverLane="browser"` + config (agentUrl+token+project) into the
   WebView so ANY guest gets the icon without bundling the SDK. One shared
   inject module (kill the apps.tsx/DevPreview drift).
4. **native lane signal**: set `window.__yaverLane`; add `YaverInfo.lane`.
5. **companions**: sfmg + yaver-todo-{rn,web,flutter} call the lane-aware
   `init()` once; verify the injected path works even if they don't.
6. **closed-loop tests**: `remote-vibe-loop` extended — browser lane, assert the
   DOM `#yaver-feedback-btn` mounts + drag moves it + tap opens the overlay +
   shake injects launch; parity test web↔RN lane detection.
