# Native / WebRTC / Browser Runtime Deep Audit

Date: 2026-07-24

This handoff focuses on browser-driven runtime surfaces for Flutter, React Native / Expo, Swift, Kotlin / Android, browser-window, vibing, and native WebRTC. It complements `BROWSER_REMOTE_BOX_RUNNER_ANALYSIS.md`, which covers the broader browser-to-remote-box control plane.

The code is the source of truth. The important split is:

- `/dev/*` and PreviewPane are the dev-server/browser-iframe lane.
- `/vibing/preview/*` is the screenshot/video proof lane for watching a dev server while code changes.
- `/remote-runtime/*` is the interactive native/WebRTC lane for simulators, emulators, physical devices, browser-window, and desktop-screen targets.
- Hermes is React Native / Expo only.
- Flutter, Swift, and Kotlin must never silently downgrade to Hermes.

## Top-Level Runtime Families

Source: `desktop/agent/remote_runtime.go`

`executionModeForFramework` maps frameworks to execution modes:

- `expo`, `react-native` -> `rn-hermes`
- `next`, `nextjs`, `vite`, `react`, `firebase`, `supabase`, `convex`, `yaver-serverless` -> `web-webview`
- `swift`, `kotlin`, `flutter` -> `native-webrtc`
- `browser` -> `native-webrtc`, target `browser-window`
- unknown -> `unsupported`

This mapping is around `desktop/agent/remote_runtime.go:188`.

Important nuance:

- RN/Expo are Hermes-primary, but they are also simulator/emulator streamable through WebRTC.
- Flutter is WebRTC-family because its UI runs in its own Skia/Impeller process and cannot be treated as a Hermes guest bundle.
- Swift/Kotlin native apps are WebRTC-family because the real app must run in a simulator/emulator/device process.
- `browser` is modeled as native-WebRTC because the target is a headless Chromium window streamed through the same runtime viewer path.

## Default Surface Policy

Source: `desktop/agent/remote_runtime.go`

`defaultStreamingSurface` is around `desktop/agent/remote_runtime.go:276`.

Defaults:

- RN / Expo -> browser streaming surface for remote-runtime alternatives, while Hermes remains the primary Yaver mobile hot-reload surface.
- Flutter -> browser streaming surface by default, because Flutter Web is lighter than simulator/emulator.
- Kotlin -> emulator.
- Swift -> simulator.
- Web frameworks -> browser.

`streamingSurfaceOptions` is around `desktop/agent/remote_runtime.go:291`.

Supported alternatives:

- RN / Expo: browser, emulator, simulator.
- Flutter: browser, emulator, simulator.
- Kotlin: emulator.
- Swift: simulator.
- Web frameworks: browser.

Audit conclusion:

- The default policy is cost-aware: browser first where it is honest, emulator/simulator only when required or explicitly chosen.
- This is intentional because Android/redroid and Apple simulators impose much higher CPU/memory/toolchain cost than a browser tab.

## Dev Server Lane

Sources:

- `desktop/agent/devserver_kind.go`
- `mobile/src/lib/devLane.ts`
- `desktop/agent/devserver_relayauth.go`

Dev-server kind classification:

- Vite / Next / Flutter -> web.
- React Native -> mobile.
- Expo -> hybrid.
- `FrameworkToDevServerKind("expo")` returns mobile unless an explicit `expo-web` route is used.

Relevant code:

- `desktop/agent/devserver_kind.go:1`
- `mobile/src/lib/devLane.ts:1`

Important bug memory:

- Browser Reload once silently became a Hermes native build for Expo/RN because the mobile path hardcoded `caller:"mobile"`.
- `browserLaneStartBody()` now sends `{ platform: "web", caller: "web-ui" }`.
- `mustUseNativePreview()` refuses to treat a web-served status as native, even for Expo/RN.

Relay-auth preview issue:

- `desktop/agent/devserver_relayauth.go` documents a real relay bug where the first proxied page loaded with `__rp`, but subresources such as `flutter.js`, `main.dart.js`, Metro bundles, or CanvasKit fetched without that query and received 401.
- The agent now rewrites static relative `src` / `href` references and injects a same-origin dynamic fetch/XHR/createElement shim.
- This is a workaround until relay HttpOnly preview cookies can fully replace query-token propagation.

Security note:

- The shim does not create a new credential. It propagates only auth query params already visible in `location.search`, and only to same-origin requests.
- It is still weaker than an HttpOnly cookie because page JS can already read the URL query.

## Vibe Preview Lane

Sources:

- `desktop/agent/vibe_preview.go`
- `desktop/agent/vibe_preview_http.go`
- `desktop/agent/vibing_actions_http.go`
- `web/lib/agent-client.ts`

Vibe preview is not the same as remote-runtime WebRTC.

Vibe preview:

- Opens a browser automation session.
- Navigates to a dev-server URL.
- Captures screenshots at a configured FPS.
- Stores recent frames in an in-memory ring and persists frame files under `~/.yaver/vibe-preview`.
- Emits SSE events for frames, stable frames, errors, clips, summaries, and lifecycle.
- Supports clip recording through `/vibing/preview/clip/*`.

Relevant code:

- `VibePreviewManager` starts around `desktop/agent/vibe_preview.go:1`.
- Profiles are around `desktop/agent/vibe_preview.go:31`.
- Start/stop/status/snapshot handlers are in `desktop/agent/vibe_preview_http.go`.
- Browser client methods are around `web/lib/agent-client.ts:4524`.

Profiles:

- `live-direct`: 8 FPS, 1280x720, quality 75.
- `live-relay-wifi`: 4 FPS, 1280x720, quality 60.
- `live-relay-cell`: 2 FPS, 854x480, quality 50.
- `change-only`: no continuous FPS.
- `summary-only`: no continuous FPS.

Vibing actions:

- `handleVibingCommit` can commit and push project changes.
- `handleVibingDeploy` can select deploy targets and may defer through Cloud Workspace placement.
- Guest project access is checked before project actions.

Audit conclusion:

- Vibe preview is a proof/observation surface, not an input-control runtime.
- It is correct for "show me what the agent changed in a browser".
- It is not enough for native Swift/Kotlin/Flutter device UX unless the app is actually running in a streamable target.

Risk notes:

- Start/stop are mutating and should remain owner-gated.
- Reads are under the `/vibing/*` scope prefix, so scoped/guest semantics must remain explicit.
- Slow SSE clients must not stall capture; current fan-out uses non-blocking sends and drops events for slow consumers.
- Frame disk paths are intentionally not JSON-leaked.

## Remote Runtime HTTP API

Sources:

- `desktop/agent/httpserver.go`
- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_webrtc.go`
- `web/lib/agent-client.ts`
- `mobile/app/remote-runtime.tsx`
- `web/components/dashboard/RemoteRuntimeViewer.tsx`

Routes:

- `GET /remote-runtime/capabilities`
- `GET /remote-runtime/sessions`
- `POST /remote-runtime/sessions`
- `GET /remote-runtime/sessions/<id>`
- `DELETE /remote-runtime/sessions/<id>`
- `POST /remote-runtime/sessions/<id>/webrtc/offer`
- `GET /remote-runtime/sessions/<id>/frame`
- `POST /remote-runtime/sessions/<id>/control`
- `POST /remote-runtime/sessions/<id>/command`
- `GET /remote-runtime/turn-credentials`
- `GET /stream/webrtc/ice`

Route registration is around `desktop/agent/httpserver.go:1022`.

Browser client methods:

- `getRemoteRuntimeCapabilities` around `web/lib/agent-client.ts:4258`.
- `startRemoteRuntimeSession` around `web/lib/agent-client.ts:4268`.
- `sendRemoteRuntimeCommand` around `web/lib/agent-client.ts:4280`.
- `createRemoteRuntimeWebRTCAnswer` around `web/lib/agent-client.ts:4337`.
- `fetchRemoteRuntimeFrame` around `web/lib/agent-client.ts:4349`.
- `sendRemoteRuntimeControl` around `web/lib/agent-client.ts:4362`.

Session creation:

- `RemoteRuntimeManager.Create` validates capability, target, and transport around `desktop/agent/remote_runtime.go:720`.
- `transportMode` defaults to `direct-webrtc`.
- `relay-jpeg-poll` is explicitly supported as a fallback.
- Browser-window sessions are immediately attached and navigated to the current project dev-server URL when possible.

Capabilities handler:

- `desktop` pseudo-framework may omit `workDir`.
- Every real project framework requires `workDir`.
- Missing `workDir` is treated as a client bug, not silently defaulted.

## WebRTC Transport Modes

Sources:

- `desktop/agent/remote_runtime_webrtc.go`
- `desktop/agent/remote_runtime_streamer.go`
- `desktop/agent/remote_runtime_video_track.go`
- `web/components/dashboard/RemoteRuntimeViewer.tsx`
- `mobile/app/remote-runtime.tsx`

There are three practical frame transports:

1. `webrtc-rtp-h264-v1`
2. `webrtc-datachannel-jpeg-v1`
3. `relay-jpeg-poll-v1`

The viewer always offers a video transceiver:

- Web dashboard viewer: `web/components/dashboard/RemoteRuntimeViewer.tsx`.
- Mobile WebView-generated viewer: `mobile/app/remote-runtime.tsx`.

The agent chooses the streamer:

- `selectRemoteRuntimeStreamer` is in `desktop/agent/remote_runtime_streamer.go`.
- If the offer contains `m=video` and the target can encode H.264, the agent uses RTP H.264.
- Otherwise it uses JPEG over a WebRTC data channel.

RTP H.264:

- Preferred path.
- Browser decodes through `<video>`.
- Supports multi-viewer fan-out because Pion can attach the same track to multiple peer connections.
- Android emulator/device can encode when `adb` exists.
- Physical iOS can encode when macOS + `ffmpeg` + WDA MJPEG are available.
- iOS simulator currently does not encode RTP H.264 because current `simctl recordVideo` no longer supports streaming to stdout.

JPEG data channel:

- Fallback direct-WebRTC path.
- Agent sends complete JPEG frames over a `frames` data channel.
- Single-viewer behavior is retained for JPEG-DC because large data-channel frames are not efficient to broadcast.
- Frames are capped by `remoteRuntimeMaxJPEGDataChannelBytes = 60 KiB`.
- Capture loop ticks every 700 ms.
- JPEG quality is reduced until the cap is met or quality reaches 35.

Relay JPEG polling:

- Non-WebRTC fallback.
- Viewer calls `GET /remote-runtime/sessions/<id>/frame` about every 900 ms.
- Used when the browser is connected through relay and direct media path is likely unavailable.
- Mobile UI explicitly tells the user relay mode means still frames, not live video.

Audit conclusion:

- "WebRTC" is not one guarantee. On Android it may be real RTP H.264. On iOS simulator it currently means JPEG data-channel fallback. On relay it may be HTTP JPEG polling, not WebRTC.
- UI and diagnostics must always show the negotiated `frameTransport`, not only requested `transportMode`.

## ICE / TURN / Network Reality

Sources:

- `desktop/agent/doctor_webrtc_ice.go`
- `desktop/agent/doctor_webrtc.go`
- `desktop/agent/stream_webrtc.go`
- `web/components/dashboard/RemoteRuntimeViewer.tsx`
- `mobile/app/remote-runtime.tsx`

ICE server config:

- The agent uses `iceServersForPeer`.
- STUN is always present.
- TURN is added only when the relay/TURN configuration exists.
- Browser viewers fetch ICE servers from `/stream/webrtc/ice` or `/remote-runtime/turn-credentials`.

Non-trickle signaling:

- Browser creates offer.
- Browser waits up to about 2 seconds for ICE gathering.
- Browser posts SDP once to `/remote-runtime/sessions/<id>/webrtc/offer`.
- Agent creates an answer and waits for gathering completion before replying.
- There is no ongoing `addIceCandidate` trickle path.

ICE doctor:

- `doctor_webrtc_ice.go` exists because dependency inventory is not enough.
- It gathers candidates using the same ICE config as live sessions.
- It classifies:
  - `none`: no usable network candidates.
  - `lan-only`: host candidates only.
  - `srflx-only`: works on LAN / cone NAT but fails on CG-NAT and many cellular paths.
  - `relay-ok`: TURN relay candidate present.

Audit conclusion:

- A remote box can have every tool installed and still be unusable from a phone on LTE if TURN is absent or misconfigured.
- `srflx-only` is intentionally degraded, not healthy.
- The product should not claim "WebRTC ready anywhere" unless relay candidates are present.

## Runtime Targets

Source: `desktop/agent/remote_runtime_target.go`

`runtimeTarget` abstracts:

- Attach
- Tap
- Swipe
- Text
- Key
- Pinch
- Navigate
- Screenshot
- Capture subprocess
- NAL reader
- H.264 encodability

Target ids:

- `ios-simulator`
- `ipados-simulator`
- `watchos-simulator`
- `tvos-simulator`
- `visionos-simulator`
- `android-emulator`
- `android-wear`
- `android-tv`
- `android-xr`
- `android-auto`
- `android-device`
- `android-redroid`
- `ios-device`
- `browser-window`
- `desktop-screen`
- `stream-*`

Audit conclusion:

- Device behavior is centralized correctly. New device types should implement `runtimeTarget`; avoid reintroducing scattered `switch targetID` branches.
- Transport behavior is intentionally separate through `remoteRuntimeStreamer`.

## Swift / Apple Native

Sources:

- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_target.go`
- `desktop/agent/remote_runtime_ios_device.go`
- `desktop/agent/remote_runtime_dispatch.go`
- `desktop/agent/preview_surface_matrix_test.go`

Swift capability behavior:

- Native Swift defaults to Apple simulator targets.
- SwiftWasm / Tokamak is detected from project files and can use `browser-window` first, even on Linux.
- Native Swift on non-macOS cannot run local Apple simulator targets.
- Non-macOS Swift/iOS sessions can dispatch signaling to a paired Mac builder.

Apple simulator targets:

- iPhone
- iPad
- Apple Watch
- Apple TV
- Vision Pro

Requirements:

- macOS host.
- Xcode / `xcrun`.
- Installed runtime family, for example iOS/watchOS/tvOS/visionOS.

Apple simulator control:

- `Attach` boots through `testkit.IOSSimDriver`.
- Tap first tries `simctl` driver, then WDA.
- Swipe requires WDA.
- Text tries simulator driver, then WDA.
- Hardware key/button support requires WDA.
- Screenshot prefers WDA, then `simctl`.
- Navigate uses `xcrun simctl openurl`.
- Pinch is explicitly refused because `simctl` has no multi-touch primitive and proper pinch requires XCUITest.

Physical iOS target:

- Target id: `ios-device`.
- Requires macOS, Xcode, WebDriverAgent, and a real trusted iPhone/iPad.
- Control/screenshot/dims go through WDA.
- Capture uses `ffmpeg` to transcode WDA MJPEG to raw H.264.
- `CanEncodeRTPH264` requires macOS and `ffmpeg`.
- Navigate is currently refused for physical iOS because the implementation has no equivalent of `simctl openurl`.
- Pinch is currently refused pending WDA/XCUITest support.

Linux-to-Mac builder dispatch:

- `remote_runtime_dispatch.go` forwards session creation and session-scoped HTTP signaling/control/frame calls to a paired Mac builder.
- Builder URL and token live on disk under `~/.yaver/builders.json`.
- Builder URL/token are not returned to browser/Convex.
- The local session id is rewritten to a local `rr_proxy_*` id.
- The actual media flows viewer <-> Mac builder after ICE negotiation; the Linux box does not decode or re-encode frames.

Risk notes:

- The `doctor_webrtc.go` comment claims iOS simulator RTP encode via `xcrun simctl recordVideo + in-tree fragmented-MP4 parser`, but `iosSimulatorTarget.CanEncodeRTPH264()` currently returns false because modern `simctl recordVideo` cannot stream to stdout. This is documentation/comment drift inside code and should be reconciled.
- Swift native must never silently route to browser preview unless detected as SwiftWasm/Tokamak.
- Watch/tv/vision must never silently fall through to web preview. Tests explicitly guard this class.

## Kotlin / Android Native

Sources:

- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_target.go`
- `desktop/agent/remote_runtime_android_device.go`
- `desktop/agent/remote_runtime_android_surfaces.go`
- `desktop/agent/remote_runtime_redroid.go`

Kotlin capability behavior:

- Kotlin defaults to Android emulator.
- Additional surfaces are Wear OS, Android TV, Android XR, Android Auto, Redroid, and physical Android.
- No browser or Hermes path is advertised for native Kotlin.

Android emulator:

- Requires `adb` and `emulator`.
- Host support matters: Google does not ship Android emulator binaries for every OS/arch.
- On unsupported Linux/ARM-style hosts, physical Android or another host is the intended route.

Android surfaces:

- Wear/TV/XR/Auto are AVD-hinted variants of the Android emulator target.
- They share adb control/screenshot/dims/capture behavior.
- Surface-specific behavior is mostly target picking plus key mapping.
- D-pad, Wear crown-like page up/down, volume, power, recents, and menu keycodes are mapped centrally.

Physical Android:

- Target id: `android-device`.
- Uses USB or Wi-Fi attached physical device.
- USB devices are preferred over wireless for lower latency.
- Requires USB debugging and RSA prompt approval.
- Capture/control paths are the same `adb -s <serial>` primitives used for emulator.

Redroid:

- Target id: `android-redroid`.
- Requires Linux, Docker, and binder support.
- Defaults:
  - container: `yaver-remote-redroid`
  - image: `redroid/redroid:13.0.0-latest`
  - workdir: temp `yaver-redroid-runtime-data`
  - default dims: 1080x2340 at 440 dpi
- Redroid currently uses JPEG frame streaming, not RTP H.264.
- Tap/swipe/text/key/screenshot work through the Redroid surface driver.
- Pinch and navigate use Android-style primitives.

RTP H.264:

- Android emulator and physical Android can encode when `adb` exists.
- Capture uses `adb exec-out screenrecord --output-format=h264`.
- `exec-out`, not `shell`, is used to avoid CR/LF mangling corrupting the H.264 stream.
- `adb screenrecord` has a 180-second cap, so the pump restarts at 170 seconds.

Risk notes:

- Android emulator enablement should be capability-probed, not host-name guessed.
- Redroid is heavy and should stay opt-in. `DefaultPreviewModeForStack` explicitly never chooses Redroid by default.
- Android physical-device serial selection currently chooses the first attached device, USB first. Multi-device disambiguation is future work.

## Flutter

Sources:

- `desktop/agent/remote_runtime.go`
- `desktop/agent/devserver_kind.go`
- `desktop/agent/native_build.go`
- `desktop/agent/devserver_relayauth.go`

Flutter has three honest lanes:

1. Flutter Web in browser/dev-server lane.
2. Flutter native Android in emulator/device/redroid.
3. Flutter native iOS in simulator/device/Mac builder.

Default behavior:

- Flutter defaults to browser streaming surface because `flutter run -d web-server` is far lighter than emulator/simulator.
- Flutter is still classified as `native-webrtc` at the project runtime level because native Flutter does not fit the Hermes bundle model.

Web dev server:

- `webDevServerCommand("flutter")` runs:
  - `flutter run -d web-server --web-port <port> --web-hostname 127.0.0.1`
- `FlutterDevServer.Kind()` returns web.

Native build:

- `resolveNativePlatform("flutter", target)` maps:
  - device/emulator/simulator -> Flutter device install path.
  - ios/ipa/testflight -> Flutter IPA path.
  - playstore/aab -> Flutter AAB.
  - apk/local -> Flutter APK.
- `PlatformFlutterDeviceInstall` builds a debug APK via `flutter build apk --debug`.

Relay preview pitfall:

- Flutter Web is especially sensitive to subresource auth propagation because `flutter.js` dynamically loads `main.dart.js` and CanvasKit.
- `devserver_relayauth.go` exists specifically because the document could load while Flutter runtime assets 401ed.

Risk notes:

- Flutter must never be sent to Hermes.
- Flutter Web is correct for fast UI iteration, but native plugins/platform behavior require emulator/simulator/device WebRTC.
- If using relay preview, verify that all dynamic Flutter assets carry auth or use the future HttpOnly relay cookie path.

## React Native / Expo

Sources:

- `desktop/agent/remote_runtime.go`
- `mobile/src/lib/devLane.ts`
- `desktop/agent/preview_surface_matrix_test.go`
- `desktop/agent/remote_runtime.go`

RN/Expo have three distinct preview/runtime stories:

1. **Hermes push into Yaver mobile super-host**
   - Primary Yaver mobile hot-reload path.
   - Fast, cheap, runs on the user’s own phone inside Yaver.
   - Coupled to native modules available in the Yaver host runtime.

2. **Browser/RN-Web**
   - Uses Expo/RN web target in a browser.
   - Cheapest remote-runtime stream.
   - Loses native modules.
   - Useful for UI vibing.

3. **Standalone simulator/emulator over WebRTC**
   - Builds and launches the guest RN/Expo app into a booted simulator/emulator.
   - Needed when testing native modules that the Yaver host does not include.
   - Needed when testing the guest app’s own Feedback SDK in a real app process.

`run-guest` command:

- Only supported for RN simulator targets.
- Requires a booted session and workdir.
- Runs off the request path with a 20-minute timeout.
- Updates session status from `building` to `running` or `build-failed`.

Feedback behavior:

- RN simulator flow can inject a hardware shake into the remote simulator/emulator.
- The guest app’s own Feedback SDK opens inside the streamed app.
- The agent also emits `feedback-launch-request` on the events channel as a fallback/direct trigger.

Self-development guard:

- Yaver mobile self-development must refuse dangerous Hermes recursion from any surface.
- Web targets are allowed because WebRTC/web preview cannot trap the user in the same way.
- This is pinned in `desktop/agent/preview_surface_matrix_test.go`.

Risk notes:

- Do not collapse RN browser lane, Hermes lane, and simulator WebRTC lane into one "mobile preview" concept.
- Browser Reload must carry browser intent; Hot Reload must carry Hermes/mobile intent.
- Native module compatibility decides whether Hermes is honest.

## Browser-Window Target

Sources:

- `desktop/agent/remote_runtime_browser.go`
- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_target.go`

Browser-window is a runtime target, not the same as iframe preview.

Behavior:

- Launches headless Chromium through chromedp.
- Opens about:blank initially.
- Remote-runtime `Create` immediately tries to navigate it to the project dev-server URL.
- If no dev server is running, the session is left blank with an explicit note.
- Navigation validates URL scheme and allows only `http` / `https`.
- `javascript:` and `file:` are explicitly blocked because they would become script execution or local-file exfiltration through streamed pixels.

Why this matters:

- A browser-window session without navigation is a blank stream where input can "succeed" but visibly change nothing.
- The current code writes a clear `waiting-for-dev-server`, `attach-failed`, or `navigate-failed` note instead of silently showing blank frames.

Risk notes:

- Never add a URL navigation escape hatch without keeping the scheme allowlist.
- Do not use browser-window as a shortcut for native Swift/Kotlin unless the project is truly a browser-renderable variant such as SwiftWasm/Tokamak.

## Viewer Implementations

Sources:

- `web/components/dashboard/RemoteRuntimeViewer.tsx`
- `mobile/app/remote-runtime.tsx`

Web dashboard viewer:

- React component using browser WebRTC APIs directly.
- Offers `m=video`.
- Creates a primer data channel so SCTP exists even if the agent creates the real `frames` / `events` channels.
- Fetches ICE credentials from the agent.
- Waits bounded time for ICE gathering.
- Handles:
  - RTP `<video>`
  - JPEG data channel `<img>`
  - relay JPEG polling
  - pointer tap/swipe
  - text input
  - Android hardware keys
  - dims/rotation events
  - session updates

Mobile viewer:

- React Native screen embeds a WebView with generated HTML/JS.
- It chooses `relay-jpeg-poll` when `quicClient.activeRelayBaseUrl` is present.
- It waits for first real frame before closing the connection overlay.
- It reports direct WebRTC blocked when ICE fails.
- It has a 20-second no-frame timeout to avoid false "ready" states.

Audit conclusion:

- The mobile viewer currently has stronger first-frame UX than the web dashboard viewer.
- The web dashboard viewer sets connected based on peer state, which can still precede decoded pixels. Consider porting the mobile first-frame semantics to web.

## Control Plane And Control Lease

Sources:

- `desktop/agent/remote_runtime_webrtc.go`
- `desktop/agent/remote_runtime_lease.go`
- `desktop/agent/mcp_tools.go`

Controls:

- `tap`
- `swipe`
- `pinch` / `zoom`
- `navigate`
- `text`
- `back`
- `home`
- `key`

Validation:

- Coordinates must be non-negative.
- Pinch scale must be positive.
- Navigate requires a non-empty URL and target-specific support.
- Unknown actions are rejected.

Lease:

- Each live runtime session has a single-writer control lease.
- MCP exposes `runtime_take_control`, `runtime_release_control`, and `runtime_lease_status`.
- The lease prevents multiple clients from fighting over the same simulator/device.

Risk notes:

- Viewers should send stable client ids so lease behavior is deterministic.
- Anonymous legacy callers are allowed when no one else holds the lease, so old clients still work.

## MCP Runtime Tools

Sources:

- `desktop/agent/mcp_tools.go`
- `desktop/agent/remote_runtime_mcp.go`

MCP exposes the same remote-runtime path so a coding runner can drive the app, not only edit code.

Tools include:

- `runtime_targets`
- `runtime_create`
- `runtime_list`
- `runtime_control`
- `runtime_command`
- `runtime_frame`
- `runtime_stop`
- `runtime_take_control`
- `runtime_release_control`
- `runtime_lease_status`
- `runtime_dev_loop`

Implementation:

- MCP verbs proxy to local `http://127.0.0.1:18080/remote-runtime/*`.
- They use the owner bearer token from local config.
- `runtime_frame` returns a JPEG image payload so the runner can inspect app pixels.

Audit conclusion:

- This is the bridge that lets Claude Code / Codex / MCP agents do true app-in-the-loop debugging for Swift/Kotlin/Flutter/native targets.
- It should use the same manager/handlers as web/mobile to avoid behavioral drift.

## Native Build / Install Relation

Source: `desktop/agent/native_build.go`

Native build is adjacent to remote runtime:

- Remote runtime creates and controls a live target.
- Native build produces and installs an app artifact.

Supported native aliases:

- `iosNative`
- `androidNative`
- `flutter`

Targets:

- device
- simulator / emulator
- testflight
- playstore
- local / apk / aab / ipa

Important hardening:

- Extra build args are rejected if they contain shell metacharacters.
- Android device install requires `adb` and an online device.
- Flutter debug device install produces an APK and uses adb install.
- `.aab` and `.ipa` are not directly installed with misleading behavior; errors explain the right target.

Audit conclusion:

- Build/install should remain separate from runtime session creation. A session can boot a target, but launching a project app may require an explicit build/install command.

## Preview Matrix Guardrails

Source: `desktop/agent/preview_surface_matrix_test.go`

Important assertions:

- RN without a paired device can use direct URL.
- RN/Expo with paired device use Hermes bundle.
- Flutter uses direct URL / in-app SDK, no Hermes.
- Kotlin and Android Gradle use Redroid/WebRTC style viewer-triggered feedback.
- Swift native uses iOS simulator / viewer-triggered feedback.
- SwiftWasm uses direct URL / in-app SDK.
- Native Kotlin/Swift never claim an in-app feedback SDK.
- Watch/tv/vision/car/wear surfaces must not silently downgrade to a web page.

Audit conclusion:

- This test file encodes the product contract and should be expanded whenever a new runtime surface lands.

## Deep Risks / Likely Bugs To Check

1. **iOS simulator WebRTC comment drift**
   - `doctor_webrtc.go` says iOS simulator RTP encode works through `simctl recordVideo`.
   - `iosSimulatorTarget.CanEncodeRTPH264()` returns false because modern `simctl` cannot stream to stdout.
   - Fix the comment/report so doctor does not imply RTP for iOS simulator when the current runtime falls back to JPEG.

2. **Web dashboard first-frame false green**
   - Mobile viewer waits for first decoded frame or JPEG paint before closing the connection overlay.
   - Web dashboard viewer marks connected from `pc.connectionState`.
   - A peer can connect before video decodes. Port first-frame semantics to web to avoid black-screen "connected" states.

3. **TURN readiness must be surfaced**
   - Dependency doctor green is not enough.
   - ICE doctor must be shown wherever remote runtime is advertised to browser/mobile users.
   - Treat `srflx-only` as degraded, especially for phone-on-cellular to home-box use.

4. **Relay mode naming**
   - `transportMode=relay-jpeg-poll` is not WebRTC.
   - UI should say "relay still frames" or similar, not "WebRTC streaming".

5. **Browser-window blank state**
   - Current code now annotates blank sessions with a reason.
   - Keep this invariant. A blank stream without actionable note is a product bug.

6. **Flutter subresource auth**
   - Relay preview must test Flutter dynamic asset loading, not only the initial document.
   - A 200 on `/dev/` with 401 on `flutter.js` / CanvasKit is a false green.

7. **Native stack feedback claims**
   - Swift/Kotlin native do not have in-app SDK equivalents in current code.
   - Feedback should be viewer-triggered or remote-runtime protocol based, not claimed as in-app SDK.

8. **Physical device ambiguity**
   - Android and iOS physical-device targets pick the first attached device.
   - This is acceptable for solo development but risky for labs/racks.
   - Add explicit device selection before multi-device environments become common.

9. **Redroid resource cost**
   - Redroid should remain opt-in.
   - Any default path that silently selects Redroid can force heavier Cloud Workspace classes and hurt margins.

10. **MCP/runtime parity**
   - Runtime APIs are shared today through local HTTP proxying.
   - New browser/mobile runtime features should be added to the shared handler first, then exposed through MCP, not reimplemented.

## Recommended Doctor / Probe Additions

1. A combined `runtime_surface_doctor` that returns, for each candidate target:
   - target enabled
   - attach possible
   - first frame possible
   - control possible
   - negotiated frame transport
   - ICE reachability
   - actionable remediation

2. A browser-visible preview doctor that separately probes:
   - initial document load
   - static asset load
   - dynamic asset load
   - HMR websocket/EventSource path
   - relay query/cookie propagation

3. A WebRTC first-frame smoke test:
   - create session
   - negotiate offer
   - wait for decoded RTP frame or JPEG frame
   - fail if only peer connection state changes

4. A native gesture doctor:
   - tap
   - swipe
   - text
   - back/home/key
   - pinch
   - navigate
   - return "unsupported" explicitly where applicable, not generic failure

5. A builder-dispatch doctor:
   - paired builder registry readable
   - default builder set
   - builder advertises platform
   - builder auth token works
   - session create forwards
   - SDP offer forwards
   - media candidates include the builder, not the Linux proxy

## Files Inspected

- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_webrtc.go`
- `desktop/agent/remote_runtime_streamer.go`
- `desktop/agent/remote_runtime_video_track.go`
- `desktop/agent/remote_runtime_target.go`
- `desktop/agent/remote_runtime_dispatch.go`
- `desktop/agent/remote_runtime_browser.go`
- `desktop/agent/remote_runtime_android_device.go`
- `desktop/agent/remote_runtime_ios_device.go`
- `desktop/agent/remote_runtime_android_surfaces.go`
- `desktop/agent/remote_runtime_redroid.go`
- `desktop/agent/remote_runtime_mcp.go`
- `desktop/agent/doctor_webrtc.go`
- `desktop/agent/doctor_webrtc_ice.go`
- `desktop/agent/ops_webrtc_doctor.go`
- `desktop/agent/devserver_kind.go`
- `desktop/agent/devserver_relayauth.go`
- `desktop/agent/native_build.go`
- `desktop/agent/vibe_preview.go`
- `desktop/agent/vibe_preview_http.go`
- `desktop/agent/vibing_actions_http.go`
- `desktop/agent/preview_surface_matrix_test.go`
- `web/lib/agent-client.ts`
- `web/components/dashboard/RemoteRuntimeViewer.tsx`
- `mobile/app/remote-runtime.tsx`
- `mobile/src/lib/devLane.ts`
