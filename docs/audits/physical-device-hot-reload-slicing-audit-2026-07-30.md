# Physical Device Hot Reload Slicing Audit

Date: 2026-07-30

## Question

Can Yaver run React Native / Flutter dev-server workflows with hot reload while
the app is shown through WebRTC on physical devices, and can that work across
phone, tablet, TV, watch, car, and AR/VR surfaces?

## Verdict

Yes for the default host-driven model. Do not collapse it into the existing
browser or Hermes lanes.

The default model should stay:

```text
one capable Yaver box
  - AI runner
  - build/dev server
  - browser renderer or stream publisher
  - project files + hot-reload watcher
```

The physical-device track adds one more boundary only when the runtime target is
a real phone/tablet/TV/watch/headset:

```text
AI runner           Mac/Linux/VPS Yaver box
build/dev server    same Mac/Linux/VPS by default
stream publisher    same Mac/Linux/VPS via adb/WDA, or device app publisher
runtime device      physical Android/iOS/tv/watch/XR device
viewer/control      web UI, Yaver mobile app, tablet, TV, AR/VR
```

Browser UI and Hermes keep their current two-level behavior. The deeper slicing
is physical-device-only.

## Why The Extra Slice Exists

A browser tab, emulator, simulator, or Redroid container can be created and
captured by the same Yaver box that runs the dev server.

A physical device is different:

- It may run the guest app but not the local Metro/Flutter toolchain.
- It may publish its own screen only after platform capture consent.
- It may need a host bridge for install, launch, debug attach, screenshots, and
  input.
- It may be on a different network path than the dev server.

So the product must name separate roles instead of saying "renderer" for all of
them.

## Default User Path

90% of usage should be:

1. Add one Yaver device.
2. That device is the AI runner, build/dev-server host, browser renderer, and
   stream publisher.
3. The user debugs through Yaver web UI or Yaver mobile.
4. Browser preview remains the fastest default for RN-web, Flutter-web, Vite,
   Next, and generic web stacks.

This is intentionally the same-machine path. It is the stable lane and must not
be regressed by physical-device work.

## React Native

### Browser / RN-web

Works today when the project has a web target. Metro or Expo web runs on the
Yaver box; the browser renderer runs on the same box; the web/mobile viewer
shows it. Hot reload stays on the existing dev-server path.

### Hermes In-App Lane

Works as the existing Yaver mobile super-host lane. It is not the same as
physical-device WebRTC. Keep it separate:

- Hermes lane: push/evaluate bundle inside Yaver app.
- Physical lane: install/launch the guest app or open the already-installed app
  on a real device and stream pixels back.

### Physical Android

Feasible:

- Metro/Expo dev server on Mac/Linux/VPS.
- Real Android device runs the debug/dev app.
- Device reaches Metro via LAN, Tailscale, adb reverse, or a relayable tunnel.
- Stream publisher is host adb screenshot/screenrecord or device MediaProjection
  publisher.
- Hot reload works if the device can reach the packager and the app is a debug
  or dev-client build.

### Physical iOS

Feasible with a Mac host:

- Metro on the Mac.
- Signed debug/dev app on the iPhone/iPad.
- Device reaches Metro.
- Stream/control through Mac-owned WDA/XCTest path or user-approved ReplayKit
  publisher.

iOS is not a general dev-server host.

## Flutter

### Browser / Flutter Web

Works on the existing browser lane:

- `flutter run -d web-server` or equivalent runs on the Yaver box.
- Browser renderer on the same box streams the UI.
- Hot reload/restart belongs to the Flutter tool process on that box.

### Physical Android

Feasible:

- Flutter tool on Mac/Linux/VPS owns `flutter run` against the device.
- Device runs the debug app.
- Stream publisher is host adb or device MediaProjection.
- Hot reload works through the Flutter tool/debug service while the host process
  is alive.

### Physical iOS

Feasible only with a Mac build/debug host:

- Flutter tool + Xcode signing on Mac.
- Real iPhone/iPad runs the debug app.
- Stream/control through Mac-owned WDA/XCTest path or ReplayKit publisher.
- Hot reload works only while the Mac-hosted Flutter debug process owns the app
  connection.

## Android On-Device Host Mode

Android can have an advanced second mode:

```text
Yaver Android app
  - embedded agent
  - optional proot/rootfs
  - optional Node/npm/git/coding CLIs
  - local loopback services
```

This can run some server/tooling work on the phone itself, especially for
JavaScript/back-end helpers. It is not the default because it depends on:

- packaged agent/rootfs/proot availability,
- Android foreground-service lifecycle,
- filesystem/exec constraints,
- memory/thermal limits,
- runner auth and installed CLI availability,
- Play policy and user-visible foreground-service requirements.

Use this only behind explicit capability checks. It is not required for the
normal physical-device hot-reload lane.

## iOS On-Device Host Mode

Do not promise this.

iOS can run a signed Yaver app, WebKit-hosted web content, bundled/interpreted
logic within platform rules, and ReplayKit capture. It cannot honestly replace a
Mac/Linux dev box for:

- arbitrary process spawning,
- Node/npm/Flutter/Xcode toolchains,
- long-running unattended daemon behavior,
- installing/launching arbitrary executable code.

For iOS physical-device development, the Mac remains the host.

## Surface Matrix

| Surface | Default host | Runtime target | Hot reload | Stream publisher | Notes |
|---|---|---|---|---|---|
| Browser UI | Same Yaver box | Browser tab | Yes | Same box | Keep stable default |
| RN Hermes | Same Yaver app/box path | Yaver app container | Bundle push | Native app surface | Keep separate |
| Android phone/tablet | Mac/Linux/VPS | Physical device | Yes | adb or MediaProjection | Good physical track |
| Android TV | Mac/Linux/VPS | TV emulator/device | Partial | adb or app publisher | D-pad controls matter |
| Wear OS | Mac/Linux/VPS | Wear emulator/device | Limited | adb or app publisher | Small viewport/input limits |
| Android Auto | Mac/Linux/VPS | Automotive emulator/head unit | Limited | adb/app publisher | UX constrained by car templates |
| Android XR | Mac/Linux/VPS | XR emulator/device | Partial | adb/app publisher | XR capture/control path needs proof |
| Redroid | Linux host | Redroid container | Yes | Same Linux host | Needs binder + disk |
| iPhone/iPad | Mac | Physical device | Yes for debug builds | WDA or ReplayKit | Mac required |
| Apple TV | Mac | tvOS app/device | Limited | App-specific/ReplayKit | Not a host |
| Apple Watch | Mac | watch app/device | Very limited | No general stream lane | Prefer simulator first |
| Vision Pro | Mac | visionOS app/device | Possible for signed app | ReplayKit/viewer path | Rich viewer, not host |

## Product Requirements

### Capability roles

Add role names to the UI and API vocabulary:

- `runnerHost`
- `devServerHost`
- `streamPublisher`
- `runtimeDevice`
- `viewer`

Default all host roles to the same selected Yaver box. Only physical-device mode
needs a separate `runtimeDevice`.

### Failure codes

Physical mode must name exact missing capability:

- `adb_authorization_required`
- `wda_required`
- `device_packager_unreachable`
- `flutter_debug_session_required`
- `media_projection_permission_required`
- `replaykit_broadcast_required`
- `on_device_host_not_supported`
- `redroid_binder_missing`
- `redroid_disk_too_low`

### UX

Runtime Lab should default to "Single device":

- Web UI in browser first.
- Browser-window WebRTC second when useful.
- Simulators/emulators/Redroid after that.

Physical Device mode should show:

- AI runner: selected box
- build/dev server: selected box
- stream publisher: selected box or device publisher
- runtime device: attached physical device

That makes the split visible without disturbing the default path.

## External Constraints Checked

- Android MediaProjection captures display/app content into a virtual display
  and Android 14+ requires the `mediaProjection` foreground-service type:
  https://developer.android.com/media/grow/media-projection
  https://developer.android.com/about/versions/14/changes/fgs-types-required
- Android app launching and deep links use intents:
  https://developer.android.com/training/basics/intents/sending
  https://developer.android.com/reference/android/content/Intent
- ReplayKit is Apple's user-approved screen recording/broadcast framework:
  https://developer.apple.com/documentation/replaykit
- Apple UI automation/XCTest can record/run UI automation and collect
  screenshots/video, but the Mac remains the automation host:
  https://developer.apple.com/videos/play/wwdc2025/344/
- Redroid is Android-in-Docker on a Linux host and needs Linux kernel support:
  https://github.com/remote-android/redroid-doc

## Decision

Build physical-device slicing, but keep it scoped:

1. Existing browser UI lane remains single-box and default.
2. Existing Hermes lane remains separate.
3. Existing simulator/emulator/Redroid WebRTC remains host-owned.
4. Physical-device mode adds `runtimeDevice` as a separate role.
5. Android on-device host is advanced and gated.
6. iOS on-device host is not promised; Mac-hosted physical streaming is the
   supported architecture.
