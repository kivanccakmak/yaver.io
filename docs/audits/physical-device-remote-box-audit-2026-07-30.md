# Physical Device as Remote Box Audit

Date: 2026-07-30

## Question

Can a physical phone/tablet/watch/TV/headset act as the Yaver "remote box" so it
streams to web UI, tvOS, iOS, AR/VR, and other viewers?

## Answer

Not as a full Yaver remote box.

A full remote box in Yaver means a host that can run the Go agent, keep a repo
checkout, spawn coding runners, expose HTTP/WebRTC routes, install/boot runtime
targets, capture frames, receive input, and survive unattended operation.

Physical devices are valid in three narrower roles:

1. Renderer/viewer: show a Yaver session UI or WebRTC stream.
2. Runtime target: a Mac/Linux agent drives an attached physical device and
   streams it through `android-device` or `ios-device`.
3. Publisher: the device app captures/publishes its own screen using platform
   capture APIs while the user/app permits it.

They are not valid as general unattended remote boxes because mobile/TV/watch/XR
OSes do not provide the same long-running daemon, local toolchain, filesystem,
process, and simulator/emulator control surface as macOS/Linux.

## Current Yaver Code Reality

### Android physical device

`desktop/agent/remote_runtime_android_device.go` already models this correctly:

- The physical Android device is a `remote-runtime target`.
- It is attached to an agent host over USB or Wi-Fi adb.
- Capture/control are delegated through adb:
  - screenshot: `adb -s <serial> exec-out screencap -p`
  - input: `adb shell input ...`
  - dims: Android shell probes
- The agent host remains the remote box.

This is good architecture. A phone is the display/runtime being driven; the Mac
or Linux box is still the agent.

### iOS physical device

`desktop/agent/remote_runtime_ios_device.go` also models this as a target, not a
remote box:

- macOS is required.
- WebDriverAgent must be built/signed/forwarded.
- WDA handles control, screenshot, dimensions, and MJPEG capture.
- The Mac remains the agent/runtime host.

This is the only honest iPhone/iPad physical-device lane today. A real device
can be streamed over WebRTC, but the remote box is the Mac that owns WDA and the
agent.

### tvOS/watchOS/visionOS surfaces

These surfaces are currently client/viewer/control heads, not host-class remote
boxes. Existing docs already warn that tvOS can only reach LAN boxes as built
because ATS/local networking/self-signed TLS constraints block arbitrary public
box control without additional transport work.

## Platform Constraint Audit

Apple's platform docs reinforce this split:

- ReplayKit is the user-approved app/screen recording and broadcast framework:
  https://developer.apple.com/documentation/replaykit
- Background execution is entitlement/mode-limited, not an arbitrary daemon
  model:
  https://developer.apple.com/documentation/xcode/configuring-background-execution-modes
- iOS/iPadOS background work is scheduled/continued work, not a general
  always-on agent:
  https://developer.apple.com/documentation/backgroundtasks
- watchOS background execution is limited to specific active domains such as
  workout/audio/location sessions:
  https://developer.apple.com/documentation/watchkit/background-execution
- ScreenCaptureKit/ReplayKit-style capture APIs are capture/publish APIs, not
  shell/toolchain/runner APIs:
  https://developer.apple.com/documentation/screencapturekit/

Those APIs can make a device publish frames. They do not make the device a
general-purpose Yaver box.

## Capability Matrix

| Device class | Can be viewer | Can be runtime target | Can publish own screen | Can be full remote box |
|---|---:|---:|---:|---:|
| Android phone/tablet | Yes | Yes, through adb host | Yes, app/media-projection path | No, not for Yaver runner/agent parity |
| iPhone/iPad | Yes | Yes, through Mac + WDA | Yes, ReplayKit/Broadcast Upload | No |
| Apple TV | Yes | Limited target only through app-specific test harness | App-specific only | No |
| Apple Watch | Thin viewer/control only | Simulator target via Mac; physical target is very constrained | No general screen stream lane | No |
| Vision Pro | Viewer/renderer yes | Simulator target via Mac; physical support needs a signed app/capture lane | Possible via platform capture APIs with limitations | No |
| Mac | Yes | Yes | Yes | Yes |
| Linux box | Yes | Android/browser/desktop yes; iOS no | Yes for desktop/browser | Yes |

## What We Should Build

### 1. Keep "remote box" host-class explicit

Add/keep a host class distinction:

- `agent-host`: macOS/Linux/Windows machine running the Go agent.
- `runtime-target`: simulator/emulator/physical device driven by an agent host.
- `viewer`: web/mobile/tv/watch/vision UI consuming a stream.
- `publisher-device`: device app that publishes its own frames/events while
  foregrounded or under an approved broadcast session.

Do not collapse these into one "device can be remote box" label.

### 2. Product wording

Use:

- "Use this phone as a renderer/viewer."
- "Stream this attached Android/iPhone device through your Mac/Linux box."
- "Publish this device's screen to a Yaver session."

Avoid:

- "Use this iPhone/watch/TV as a remote box."
- "Run Yaver agent on Apple TV/watch as a box."
- "Run runners/toolchains on the phone."

### 3. Supported near-term lanes

High-confidence:

- Android physical device target via adb.
- iPhone/iPad physical target via Mac + WDA.
- Device as WebRTC viewer.
- Device app as a foreground publisher to the agent/relay.

Medium-confidence:

- visionOS device as a rich viewer/renderer.
- Vision Pro as publisher through platform capture APIs, if user-approved and
  app/content protection allows it.

Low-confidence / do not promise:

- watchOS as a live screen publisher.
- tvOS as a general remote host.
- iOS/tvOS/watchOS/visionOS as unattended runner hosts.

## Failure Plumbing Requirements

Every surface must name which role is missing:

- `host_required`: "This needs a Mac/Linux Yaver agent host."
- `wda_required`: "iPhone/iPad physical streaming needs WebDriverAgent running
  and forwarded from the Mac."
- `adb_required`: "Android physical streaming needs adb authorization."
- `broadcast_permission_required`: "Device screen publishing needs the user to
  start the platform broadcast."
- `background_not_supported`: "This surface cannot keep an unattended remote box
  alive in the background."

The UI should not say "device unreachable" when the truth is "this device is a
viewer, not an agent host."

## Verdict

Physical devices are first-class Yaver surfaces, renderers, and runtime targets.
They are not replacement remote boxes.

The correct architecture is sliced:

- remote runner/coding: Mac/Linux agent host
- renderer/viewer: any capable surface
- physical device runtime: attached target driven by the host
- device self-publish: foreground/broadcast-session publisher, not a daemon

That fits the runner/renderer slicing model without promising an impossible
mobile daemon.
