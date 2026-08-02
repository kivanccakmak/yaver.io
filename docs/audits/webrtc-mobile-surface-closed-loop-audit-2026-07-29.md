# WebRTC Mobile Surface Closed-Loop Audit — 2026-07-29

## Scope

Dogfood failure: companion/todo apps are mobile apps, but the RN/Flutter browser
lane streamed desktop-shaped frames. The audit used live agent operations on:

- `ubuntu-4gb-hel1-1` at `http://100.75.123.78:18080`
- local Mac agent at `http://127.0.0.1:18080`
- local Xcode simulators: iOS 26.2, tvOS 26.2, watchOS 26.2, visionOS 26.2

Credentials were read only from the local Yaver config and never printed.

## Findings

### 1. RN browser-window streams real pixels, but not mobile framing

Live result before the viewport guard:

```text
[browser-jpeg] PIXELS yaver-todo-rn (Todo RN) / mobile — JPEG-DC 720x450, frames=3, center=rgb(0,129,3), uniqueGrid=5
[browser-jpeg-control] PIXELS yaver-todo-rn (Todo RN) / mobile — frame changed after control input; frames=5
```

The stream is real. The form factor is wrong: `720x450` is landscape/desktop,
not the expected mobile portrait.

After enabling the new guard:

```text
todo-rn: browser-window displaySurface=undefined; expected "mobile-web" for expo
```

The current source already contains the intended product contract:

- `browserWindowTargetForFramework(expo|react-native|flutter)` sets
  `displaySurface: "mobile-web"` and `viewport: 393x852`.
- `RemoteRuntimeManager.Create` copies the selected target viewport onto the
  session.
- `attachAndNavigateBrowserWindow` calls `AttachViewport` when a viewport exists.

But the running local agent `1.99.389` and the Linux box both omit those
capability fields and render desktop-shaped JPEGs. This is release/runtime drift
that the live e2e test now catches before it can look green on pixels alone.

### 2. iOS simulator run-guest was reaped while still building

The direct iOS loop created an iPhone simulator session and captured baseline
frames, then `run-guest` returned `building`. The session later disappeared:

```text
session rr_... status=control-ready device=24B591E9…
baseline frame before launch: 57164 bytes
launching the guest app into the simulator
building
...
NAMED  session status refused (HTTP 404): remote runtime session not found
```

Root cause in source: the reaper used the no-viewer idle grace even for
`status="building"`. A cold RN build is expected to run for minutes; killing its
session turns a truthful build state into a later 404.

Product hardening landed in source:

- `ReapAbandonedSessions` now skips `building` sessions.
- `TestReaperKeepsBuildingSession` pins the behavior.
- `e2e/ios-simulator-loop.mjs` now waits for async build status before judging
  frames, and preserves 404/build-failed as NAMED instead of SILENT.

### 3. tvOS/watchOS/visionOS incorrectly accepted run-guest

Live probes against local special-surface projects showed:

```text
tvos-simulator: run-guest accepted status=building
watchos-simulator: run-guest accepted status=building
visionos-simulator: run-guest accepted status=building
```

The implementation underneath falls through to `buildAndLaunchRNiOS`, which
builds `Debug-iphonesimulator`. That cannot honestly claim to build and launch
an Apple TV, Watch, or Vision app.

Product hardening landed in source:

- daemon `isRNSimulatorTarget` now excludes `watchos-simulator`,
  `tvos-simulator`, and `visionos-simulator`;
- web and mobile `canRunGuestOnRemoteTarget` allowlists were updated in the same
  change;
- parity tests were updated so future copy drift is caught.

### 4. Apple special-surface frame capture is load-sensitive and now probed

The first special-surface probes created sessions, but every frame attempt
returned a specific HTTP 400 while the Mac was overloaded:

```text
screen capture gave up after 20s (budget 20s) — the box is too busy to screenshot, not broken.
```

The original probe mislabeled this as SILENT. That was a harness bug. The new
`e2e/apple-surface-frame-loop.mjs` records those as NAMED because the product did
state the reason and route: run the WebRTC/CoreSimulator doctor.

After load eased, the same tvOS probe captured frames:

```text
tvos-simulator: PIXELS 3 frames, sizes 12493, 12493, 12493
```

That proves session create + Apple TV simulator frame capture. It still does not
prove app launch because the running agent accepted `run-guest` for tvOS; the
source patch makes that an immediate refusal until a real tvOS build/launch route
exists.

## Test/Artifact Changes

- `e2e/tests/remote-runtime-browser-jpeg.spec.ts`
  - adds capability preflight for `displaySurface="mobile-web"` and portrait
    viewport when `E2E_EXPECT_MOBILE_VIEWPORT=1`;
  - keeps the decoded JPEG shape check.
- `e2e/ios-simulator-loop.mjs`
  - waits for `run-guest` async build status before judging pixels;
  - preserves session disappearance/build failure as NAMED.
- `e2e/apple-surface-frame-loop.mjs`
  - new direct simulator frame probe for tvOS/watchOS/visionOS.
- `desktop/agent/remote_runtime_reaper.go`
  - does not reap `building` sessions.
- `desktop/agent/remote_runtime.go`, web, mobile
  - remove impossible Apple special-surface `run-guest` acceptance.

## Verification

Passed:

```text
npx tsc --noEmit -p e2e/tsconfig.json
```

Live browser-window guard failed as intended against the currently running Mac
agent:

```text
todo-rn: browser-window displaySurface=undefined; expected "mobile-web" for expo
```

Live tvOS simulator frame probe passed capture after load eased:

```text
PIXELS 3 frames, sizes 12493, 12493, 12493; last frame /tmp/yaver-tvos-simulator-frame-2.jpg
```

Go focused tests were attempted, but the `go test` wrapper hung without spawning
a package test binary under current machine load and was terminated. Re-run when
CoreSimulator/build load settles:

```bash
cd desktop/agent
go test . -count=1 -run 'TestRunGuestTargetListMatchesGoAllowlist|TestRunGuestTargetListMatchesClientAllowlists|TestIsRNSimulatorTarget|TestReaperKeepsBuildingSession'
```

## Next Required Product Work

1. Ship/restart through the signed release path so the running agent carries the
   browser-window mobile viewport contract.
2. Add a product route for special-surface app launch if tvOS/watchOS/visionOS
   should support `run-guest`; until then the product must refuse it, as patched.
3. Run the WebRTC/CoreSimulator doctor after the machine is less loaded, then
   rerun the special-surface frame loop to separate host load from capture bugs.
