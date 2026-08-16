# Multi-Device Closed-Loop Rendering Audit

Date: 2026-07-25

Scope: tvOS wall display, browser/WebRTC preview, Android TV, Android Auto,
Wear OS, watchOS, CarPlay, mobile/tablet, AR/VR, and native test apps
(Swift, Kotlin, Flutter). This is an audit-first document. Code is still the
source of truth; every endpoint and symbol below must be re-grepped before a
future change relies on it.

## Goal

Yaver should behave like one shared runtime room:

- The user can speak or type from phone, watch, car, Android remote, TV, browser,
  or headset.
- The command enters one runtime queue (`runtime_turn` / `runtime_turns`).
- The selected remote machine, including a Mac mini, runs the work.
- The result is visible on the right surface: phone for detail, car/watch for a
  one-sentence safe answer, and tvOS/browser/WebRTC for shared rendering.
- Rendering paths are proven with closed-loop tests, not just capability labels.

The failure class to prevent is: inventory says "ready", but the real operation
cannot render, stream, reload, or speak.

## Current Evidence

Verified locally on this MacBook Air:

- tvOS app builds with `xcodebuild -project YaverTV.xcodeproj -scheme YaverTV
  -sdk appletvsimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO`.
- tvOS now uses direct-first / relay-fallback for ops, REST lists, frame
  endpoints, runtime turns, and health probes.
- tvOS Live Room reads `runtime_turns`, so commands from phone/watch/car/TV can
  be shown on the television.
- Agent surface matrix targeted tests pass for Apple and Android surface target
  enumeration, key mapping, navigation, pinch, and capture selection.
- Mobile headless tests pass for watch bridge, car confirmation, car voice
  coding, and runtime-turn announcements.
- Android mobile app debug build is currently running as a real compile check
  for the shared phone/tablet/Android TV/Android Auto APK path.

Important constraints:

- Do not consume Mac mini resources for build work. Treat Mac mini as a remote
  runtime target in tests unless the user explicitly asks to run on it.
- Do not publish/upload mobile, tvOS, watchOS, Play, TestFlight, or npm artifacts
  without explicit permission.
- Do not put customer projects, private hostnames, relay secrets, or absolute
  user paths in committed tests or docs.

## Surface Contract

Every surface should satisfy this minimum loop:

1. Select or resolve the runtime machine.
2. Send a surface-aware command.
3. Put the command into `runtime_turn` or a deliberate older fallback.
4. Refresh `runtime_turns`.
5. Render state on the appropriate device.
6. Attempt the real preview/reload/stream capability when the surface claims it.
7. Report a concrete reason when it cannot.

Surface-specific output:

- Phone/tablet: full detail, controls, runtime-turn queue, test/deploy gates.
- tvOS: shared room display, project preview frames, Android/redroid frames,
  capture frames, Live Room queue, remote selection, wake.
- Browser/WebRTC: low-latency full-screen stream where supported; MJPEG/frame
  endpoints as lower-cost fallback.
- Watch/Wear: short speech/haptic reply, confirmation prompts, wake intent,
  queue handoff.
- CarPlay/Android Auto: one-sentence readback, risky command confirmation,
  no code/diff/log/path read aloud.
- AR/VR/glass: live session voice loop and stream display, no hard dependency
  on mobile-only navigation.

## Closed-Loop Test Matrix

### 1. Remote Mac Mini To tvOS, Browser, WebRTC

Purpose: prove a remote Mac mini runtime can render projects onto a TV/browser
surface instead of only passing registry/capability checks.

Test shape:

- Create a fake remote device id such as `macmini-fixture`.
- Use direct-first / relay-fallback endpoint builders without hardcoding a real
  hostname.
- Drive `runtime_turn` with a TV/browser surface descriptor.
- Verify `runtime_turns` shows the same item.
- Verify the selected preview transport is coherent:
  - TV or projector + low latency => WebRTC plan.
  - TV card/low power => MJPEG/frame fallback.
  - Browser full-screen => WebRTC offer endpoint.
- Verify the test does not require the actual Mac mini, actual relay password,
  or customer project paths.

Files to inspect before implementation:

- `desktop/agent/stream_plan.go`
- `desktop/agent/remote_runtime_webrtc.go`
- `desktop/agent/remote_runtime_browser.go`
- `desktop/agent/ops_runtime_turn.go`
- `desktop/agent/runtime_queue.go`
- `tvos/YaverTV/AgentClient.swift`
- `tvos/YaverTV/SessionClient.swift`

Suggested tests:

- `desktop/agent/multidevice_closed_loop_rendering_test.go`
  - `TestClosedLoopRemoteMacMiniTVBrowserWebRTCPlan`
  - `TestClosedLoopRuntimeTurnAppearsOnTVRoomQueue`
  - `TestClosedLoopRelayEndpointBuilderCoversPreviewAndHealth`

### 2. SFMG, Talos, Yaver Browser Reload Projects

Purpose: prove named projects select the right render path without committing
private project paths or relying on local folders that only exist on one
machine.

Use fixture project descriptors, not real repos:

- `sfmg`: web app, likely Next/Vite style.
- `talos`: browser app with Playwright/storage-state style quality checks.
- `yaver`: local Yaver web/mobile runtime.

Assertions:

- Web project preview starts the dev server before capture.
- tvOS captures via `/vibing/preview/*`, never a tvOS WebView.
- Browser sink prefers WebRTC for full-screen/low-latency.
- Reload is scoped to the selected project workDir, never agent CWD.
- Talos-style browser profile names sanitize into storage-state file names.
- Missing dev server produces a useful error, not a blank frame.

Files to inspect:

- `desktop/agent/workspace_preview_strategy.go`
- `desktop/agent/project_preview_capabilities.go`
- `desktop/agent/ops_testkit_playwright_test.go`
- `desktop/agent/stream_plan.go`
- `tvos/YaverTV/Views/WebPreviewStreamView.swift`

Suggested tests:

- `TestClosedLoopNamedWebProjectsRouteToVibingPreview`
- `TestClosedLoopBrowserSinkPrefersWebRTC`
- `TestClosedLoopReloadUsesSelectedProjectWorkDir`

### 3. Native Todo Fixtures: Swift, Kotlin, Flutter

Purpose: prove Yaver's native app test projects still exercise real build and
preview/deploy decisions for the native lanes.

Existing fixtures:

- `tests/fixtures/native-ios-swift`
- `tests/fixtures/native-android-kotlin`
- `tests/fixtures/native-flutter-app`

Assertions:

- Swift/iOS native fixture maps to iOS simulator/device build lane.
- Kotlin native fixture maps to Android device/emulator lane.
- Flutter fixture maps to Flutter build lane and reports Flutter missing through
  `webrtc_doctor` / platform deploy planning instead of failing late.
- tvOS does not falsely claim Flutter is streamable to the TV unless a web or
  native stream path exists.
- Every native fixture reports a preview/test path or a concrete unsupported
  reason.

Files to inspect:

- `desktop/agent/package_runtime.go`
- `desktop/agent/project_runtime_test.go`
- `desktop/agent/mobile_platform_matrix.go`
- `desktop/agent/ops_webrtc_doctor.go`
- `tests/fixtures/README.md`

Suggested tests:

- `TestClosedLoopNativeSwiftTodoPreviewContract`
- `TestClosedLoopNativeKotlinTodoPreviewContract`
- `TestClosedLoopFlutterTodoPreviewContract`

### 4. Watch, Wear, Car, STT/TTS Synergy

Purpose: prove non-visual surfaces can start work and get safe answers while
visual surfaces display the shared state.

Assertions:

- Watch/Wear transcript goes through `runtime_turn` when runtime injection is
  configured.
- Car reply goes through `runtime_turn` when configured, otherwise live session,
  then older task fallback.
- Risky commands require explicit confirmation on watch and car.
- `ready_to_test` is not announced as "done" until the device reload is
  verified.
- Car/watch TTS never reads code, diffs, stack traces, logs, or absolute paths.
- STT/TTS cloud calls are bounded by timeouts and surface errors safely.
- Barge-in stops local and cloud TTS.

Files to inspect:

- `mobile/src/lib/watchBridge.ts`
- `mobile/src/components/WatchBridgeHost.tsx`
- `mobile/src/lib/carReplyDispatch.ts`
- `mobile/app/car-voice-coding.tsx`
- `mobile/src/lib/runtimeTurnAnnouncer.ts`
- `mobile/src/lib/speech.ts`
- `mobile/src/lib/voice/createVoiceCore.ts`
- `wear/app/src/main/kotlin/io/yaver/wear/SessionClient.kt`

Suggested tests:

- Extend `watchBridge.test.mts` with TV queue visibility assertions.
- Extend `carReplyDispatch.test.mts` for `runtime_turn` priority over live
  session fallback when the shared runtime queue is configured.
- Extend `runtimeTurnAnnouncer.test.mts` for `ready_to_test` verified vs
  delivered/unreachable readbacks.
- Add `speech.test.mts` pure tests for timeout and markdown/path stripping.

## Gaps Found So Far

### Gap A: Closed-loop render tests are too fragmented

Existing tests cover many individual pieces:

- remote runtime target enumeration
- Android surface key mapping
- browser/WebRTC helpers
- runtime queue state transitions
- mobile runtime-turn client behavior

But there is not yet one end-to-end test that says:

> A command from a watch/car/phone targets a Mac mini runtime, the same item
> appears on tvOS Live Room, and the selected project chooses browser/WebRTC or
> frame-stream rendering correctly.

Fix: add a closed-loop test file that composes existing pure helpers instead of
booting real devices.

### Gap B: Named app coverage should use fixtures, not private paths

Tests should mention `sfmg`, `talos`, and `yaver` only as fixture labels or
synthetic project names. They must not embed real local paths, customer URLs, or
private hostnames.

Fix: create synthetic project descriptors that exercise the same framework
classification and preview strategy as the real projects.

### Gap C: tvOS has Flutter unsupported messaging

Current tvOS project UI says Flutter previews are not streamable to TV. That is
honest, but the closed-loop tests should lock this behavior so it does not drift
into a false "ready" label.

Fix: add a test that Flutter returns a concrete unsupported/needs-device reason
for tvOS unless a supported stream path is explicitly added.

### Gap D: Android Auto/Wear native source sync must be kept honest

The tracked Android manifest and `MainApplication.kt` reference Android Auto and
Wear bridge classes. The source implementations live under `mobile/native-*`
and are copied by Expo config plugins during prebuild. Local tracked Android
builds must prove those classes are present in the generated source set or fail
with a clear preflight.

Fix options:

- Keep native bridge sources copied into the tracked `mobile/android` tree.
- Or add a doctor/preflight that checks manifest + package registration +
  source files together before release.

## Proposed Implementation Order

1. Add pure Go closed-loop tests for stream planning, runtime queue visibility,
   and fixture project preview contracts.
2. Add mobile TS tests for watch/car/runtime announcer STT/TTS safety.
3. Add a preflight/doctor check for Android Auto/Wear native source sync.
4. Re-run:
   - `go test ./desktop/agent -run 'ClosedLoop|RuntimeTarget|PlatformMatrix|WebRTC|Preview|RuntimeTurn'`
   - `cd mobile && npx tsx ...watch/car/runtime/speech tests...`
   - `cd tvos && xcodebuild ... appletvsimulator ...`
   - `cd mobile/android && ./gradlew :app:assembleDebug`
5. Only after tests pass, run real-device testing:
   - Mac mini as remote runtime target.
   - Apple TV as tvOS client.
   - Browser/WebRTC sink.
   - Android TV emulator or physical Android TV.
   - Wear OS watch/emulator.
   - Android Auto DHU.
   - iPhone/iPad, Apple Watch, CarPlay simulator/real entitlement path.

## Real-Device Acceptance Checklist

- Apple TV auto-connects to the intended runtime or shows the machine picker.
- Apple TV can wake a managed box and does not show false asleep when relay
  works.
- Live Room shows commands started from phone, watch, car, Android remote, and
  TV.
- Web project preview shows frames on tvOS and WebRTC in browser/full-screen
  sinks.
- Redroid/Android frame stream renders on tvOS for Android/RN projects.
- Android TV launches from Leanback and can navigate with D-pad semantics.
- Wear OS sends a transcript, receives ack/summary/error, and can request wake.
- Android Auto notification is read aloud and RemoteInput reply re-enters JS.
- CarPlay voice state mirrors listening/working/speaking and releases audio
  session after a turn.
- STT/TTS failures time out with a spoken fallback; no surface waits forever.
- No shared screen or voice path leaks absolute home paths, code, diffs, stack
  traces, private URLs, relay passwords, or tokens.

## Definition Of Done

This audit is not done when a simulator builds. It is done when:

- Closed-loop pure tests prevent route/strategy drift.
- Build tests prove native bridge classes are in the actual generated apps.
- Real-device tests confirm the full command-to-render path on Apple TV and at
  least one Android TV/Wear/Auto surface.
- Any failed real-device case leaves a product diagnostic or failing test behind.
