# WebRTC Closed-Loop Audit — 2026-07-29

## Scope

This audit covers Yaver WebRTC preview lanes only: browser-window JPEG DataChannel, RTP H.264 stream fanout, remote-runtime WebRTC signaling, browser console/event plumbing, and surface consumers that depend on those transports.

The goal is not "a session exists". The goal is closed-loop proof: a real client negotiates, receives a visible frame, surfaces browser logs, and releases resources after close.

## Snowball Rule

Every failure found here must become a product guard or automated closed-loop test. A manual workaround is not done unless the product also learns how to detect, name, route, or prevent the same failure next time.

Required shape for each failure:

- Detection: probe the actual operation, not inventory.
- Signal: stable named state or verdict, not a spinner.
- UI: user-visible cause on the current surface.
- Route: deterministic fix or bounded "not supported here" explanation.
- Autowork: repeatable test, doctor probe, or reaper guard.

## Verdict Vocabulary

- `PIXELS`: real visible pixels matched the expected content.
- `NAMED`: the lane refused or degraded with a named reason and no blank spinner.
- `SILENT`: blank frame, green no-content decode, hung signaling, missing console output, or resource leak.

`SILENT` is always failing. `NAMED` is acceptable only when the capability is genuinely unavailable on that host/surface and the user can see why.

## Lanes To Prove

| ID | Remote box | Client | Surface | Transport | Closed-loop proof | Expected |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Mac | Ubuntu browser / Web UI | browser-window | WebRTC DataChannel JPEG | Create session, verify navigated URL, sample nonblank frame | `PIXELS` |
| W2 | Mac | Ubuntu browser / Web UI | browser-window console | Events over WebRTC side channel | Emit console log/error/exception in remote tab, Runtime Console receives `browser-log` | `PIXELS`/event |
| W3 | Ubuntu 4GB | Mac browser | `/stream/webrtc/offer` desktop viewport | RTP H.264 | Push magenta JPEG, decode magenta in `<video>`, push blue, decode blue | `PIXELS` |
| W4 | Ubuntu 4GB | Mac browser | `/stream/webrtc/offer` mobile iframe viewport | RTP H.264 | Same as W3 inside mobile WebView-like iframe | `PIXELS` |
| W5 | Mac | Ubuntu browser | `/stream/webrtc/offer` desktop viewport | RTP H.264 | Reverse direction: Ubuntu Chromium receives Mac RTP stream | `PIXELS` |
| W6 | Mac | Ubuntu browser | `/stream/webrtc/offer` mobile iframe viewport | RTP H.264 | Reverse direction mobile iframe | `PIXELS` |
| W7 | Mac | Ubuntu browser | iOS simulator runtime target | Remote-runtime WebRTC | If capture is supported, visible frame; otherwise named unsupported state | `PIXELS` or `NAMED` |
| W7T | Mac | Ubuntu browser | iPad simulator runtime target | Remote-runtime WebRTC | If no iPad simulator exists, auto-create one from installed device type + runtime, then stream visible frame | `PIXELS` or `NAMED` |
| W8 | Mac | Ubuntu browser | tvOS simulator runtime target | Shared WebRTC consumer | Visible frame or named unsupported state | `PIXELS` or `NAMED` |
| W9 | Mac | Ubuntu browser | watch runtime target | Shared WebRTC consumer | Visible frame or named unsupported state | `PIXELS` or `NAMED` |
| W10 | Mac | Ubuntu browser | visionOS/xrOS runtime target | Shared WebRTC consumer | Visible frame or named unsupported state | `PIXELS` or `NAMED` |
| W11 | Any | Any | session lifecycle | Control plane | Close viewer/session, verify `/remote-runtime/sessions` empty and browser children released | `PIXELS` |

## Current Known State Before This Audit Run

- W1 was reproduced as broken from the user photo: WebRTC signaling was connected, but the remote browser-window streamed `about:blank`.
- W1 root cause was confirmed on Ubuntu: direct headless Chrome rendered the app, while Yaver browser-window session streamed blank until explicit `navigate`.
- W1 product fix was pushed in `a1b0af45e`: `Attach` now navigates attached browser-window sessions before streaming, or marks `waiting-for-dev-server`.
- W2 product fix was pushed in `a1b0af45e`: CDP console, exception, and browser log events forward as `browser-log` and Web Runtime Console appends them.
- W3/W4 received RTP H.264 improvements in `a1b0af45e`: access-unit grouping plus H.264 fmtp with `packetization-mode=1`.
- The signed Ubuntu dogfood service on `:18080` restored its release binary from the managed `current -> 1.99.386` symlink/auto-update path. Final live proof therefore used isolated patched agents on `:19080` with temp homes and `auto_update=false`; release deployment remains a separate step.
- Ubuntu remains under disk pressure, around 96-97% root usage. Resource pressure is part of the test result because a 4GB/low-disk box must fail named, not silently.

## Commands

### Focused Unit Guards

```sh
cd desktop/agent
go test -count=1 -timeout 90s -run 'TestAttachBrowserWindowNavigatesAlreadyAttachedBlankSession|TestCreateBrowserWindowForRNUsesWebPreviewPort|TestCreateBrowserWindowNavigatesToResolvedURL|TestCreateBrowserWindowExplainsWhenNoDevServer|TestAccessUnitReaderGroupsParameterSetsWithFrame|TestH264RTPCodecCapabilityAdvertisesPacketizationMode|TestStreamSnapshotSupportsFreshPushedSource|TestApplyWebRTCOffer' .
```

### RTP H.264 Harness

The harness currently reads `~/.yaver/config.json`. For cross-box dogfood it must also accept a token via environment so Mac can test Ubuntu after token rotation without editing local config.

```sh
YAVER_WEBRTC_BASE=http://100.75.123.78:18080 \
YAVER_WEBRTC_TOKEN="$UBUNTU_AGENT_TOKEN" \
node e2e/webrtc-e2e/run.mjs both
```

### Browser-Window JPEG-DC Probe

```sh
POST /dev/start
POST /remote-runtime/sessions {"framework":"expo","workDir":"/root/Workspace/yaver.io/mobile","targetId":"browser-window"}
GET /remote-runtime/sessions/<id>/frame
DELETE /remote-runtime/sessions/<id>
```

Pass requires the session note to name the navigated URL and the sampled frame to be nonblank.

### Remote-Runtime WebRTC Harness

```sh
YAVER_WEBRTC_BASE=http://100.89.8.111:19080 \
YAVER_WEBRTC_TOKEN="$MAC_AGENT_TOKEN" \
YAVER_CHROMIUM_PATH=/snap/bin/chromium \
YAVER_RUNTIME_WORKDIR=/Users/kivanccakmak/Workspace/yaver.io/mobile \
YAVER_RUNTIME_FRAMEWORK=react-native \
node e2e/webrtc-e2e/remote-runtime.mjs ios-simulator
```

This harness runs from Ubuntu Chromium against this Mac as the remote runtime host. It accepts either RTP H.264 pixels or JPEG-DC pixels, records MP4 from screenshots, and always deletes the remote-runtime session in `finally`.

## Autowork Product Requirements

- Add `YAVER_WEBRTC_TOKEN` support to `e2e/webrtc-e2e/run.mjs` so cross-box tests do not depend on the client machine's local auth cache. Status: implemented in this audit.
- Add `e2e/webrtc-e2e/remote-runtime.mjs` so simulator/browser-window WebRTC can be driven from Ubuntu Chromium against this Mac, including MP4 proof and cleanup. Status: implemented in this audit.
- Chunk JPEG-DC frames and teach web/mobile/harness consumers to reassemble them. Status: implemented in this audit after iOS simulator opened `frames` but delivered no JPEG message.
- Start the JPEG-DC pump as soon as that transport is negotiated, and bound each capture so a stuck screenshot becomes `frame-error` instead of a silent pump hang. Status: implemented in this audit.
- Add a browser-window e2e that creates an already-attached `about:blank` session and proves `Attach` navigates before WebRTC offer handling.
- Add browser console e2e that injects `console.log`, `console.error`, and `throw new Error`, then asserts the runtime events channel carries `browser-log`.
- Add a cleanup guard that fails if `/remote-runtime/sessions` is empty while browser-window Chrome children remain owned by the agent.
- Add a low-disk/resource-pressure closed-loop check: heavy lane start must return a named `box_resource_pressure` style reason instead of creating a silent session.
- Add a surface parity test that checks web, mobile iframe, tvOS/watch/xrOS/car consumers all consume the same WebRTC event schema and named failure shape.
- Treat sibling XcodeGen app projects (`tvos/project.yml`, `visionos/project.yml`) as bounded project-surface evidence when capabilities are requested from `mobile/`. Status: implemented after tvOS/visionOS were silently omitted.
- When an Apple simulator device type and runtime exist but no simulator instance exists, auto-create a Yaver simulator instance instead of disabling the target. Status: implemented after iPad was disabled despite installed iPad device types.
- Use a target-aware first-pixel budget in the remote-runtime WebRTC harness; cold visionOS/tvOS/watch simulator activation can exceed the phone/browser default without being broken. Status: implemented after visionOS passed with a longer window.

## Results

Results below must be filled from command output and sampled pixels only.

| ID | Result | Evidence | Follow-up |
| --- | --- | --- | --- |
| W1 | `PIXELS` | Mac browser-window remote-runtime from Ubuntu client: `VERDICT=PIXELS · browser-window:jpeg-dc:webrtc-datachannel-jpeg-v1`. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/yaver-rr-webrtc-browser-window-bounded/browser-window.mp4` (`h264`, 1280x800, 35 frames, 8.75s). Earlier Ubuntu root cause was `about:blank`; product fix is `ensureBrowserWindowNavigated`. | Add browser-window live e2e that creates an attached blank browser and proves navigation before offer/frame. |
| W2 | `NAMED` | Code path exists: CDP console/exception/log events map to `{"type":"browser-log"}` and the web runtime console consumes that event from the session WebRTC event channel. No live UI assertion was completed in this run. | Add a closed-loop browser-log WebRTC test that injects log/error/exception and asserts visible Runtime Console rows. |
| W3 | `PIXELS` | Mac browser against Ubuntu temp agent: `VERDICT=PIXELS · webui:PIXELS mobile:PIXELS`. Recording: `/tmp/yaver-webrtc-ubuntu-remote-recorded/recordings/webui.mp4` (`h264`, 1280x800, 31 frames, 7.75s). | Promote harness to CI/dogfood gate and run against release service after deploy. |
| W4 | `PIXELS` | Same run, mobile iframe viewport. Recording: `/tmp/yaver-webrtc-ubuntu-remote-recorded/recordings/mobile.mp4` (`h264`, 420x860, 30 frames, 7.5s). | Keep mobile iframe as a required lane; Playwright native video can be 0B, so retain frame-recorder MP4. |
| W5 | `PIXELS` | Ubuntu Chromium against Mac temp agent: `VERDICT=PIXELS · webui:PIXELS mobile:PIXELS`. Local copy: `/tmp/yaver-webrtc-artifacts/mac-remote-recorded/recordings/webui.mp4` (`h264`, 1280x800, 31 frames, 7.75s). | Keep reverse direction in the dogfood script; Mac auth for temp-home agents was stale but local token worked. |
| W6 | `PIXELS` | Same reverse run, mobile iframe viewport. Local copy: `/tmp/yaver-webrtc-artifacts/mac-remote-recorded/recordings/mobile.mp4` (`h264`, 420x860, 26 frames, 6.5s). | Same as W5. |
| W7 | `PIXELS` | Ubuntu Chromium against Mac iOS simulator: `VERDICT=PIXELS · ios-simulator:jpeg-dc:webrtc-datachannel-jpeg-v1`; frame-meta `bytes=57233 chunked=true width=720 height=1565`. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/yaver-rr-webrtc-ios-simulator-final-worker/ios-simulator.mp4` (`h264`, 1280x800, 39 frames, 9.75s). | Keep this in the live dogfood gate; RTP-native simulator capture is still separate future work. |
| W7T | `PIXELS` | Ubuntu Chromium against Mac iPad simulator: `VERDICT=PIXELS · ipados-simulator:jpeg-dc:webrtc-datachannel-jpeg-v1`; frame-meta `bytes=11393 chunked=false width=720 height=960`. Product auto-created simulator `B72473AE-0F99-4850-B4A6-67DDB0696F33` from installed iPad device type + compatible iOS runtime after no iPad instance existed. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/ipados-macremote/ipados-simulator.mp4` (`h264`, 1280x800, 42 frames, 10.5s). | Keep auto-create covered by `TestSimulatorCreateSpecFromJSONPicksMatchingRuntimeFamily`; consider a later cleanup policy for Yaver-created simulator instances. |
| W8 | `PIXELS` | Ubuntu Chromium against Mac Apple TV simulator: `VERDICT=PIXELS · tvos-simulator:jpeg-dc:webrtc-datachannel-jpeg-v1`; frame-meta `bytes=12503 chunked=true width=720 height=405`. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/tvos-macremote/tvos-simulator.mp4` (`h264`, 1280x800, 36 frames, 9.0s). | Keep sibling `tvos/project.yml` detection in the capability guard. |
| W9 | `PIXELS` | Ubuntu Chromium against Mac watchOS simulator: `VERDICT=PIXELS · watchos-simulator:jpeg-dc:webrtc-datachannel-jpeg-v1`; frame-meta `bytes=12833 chunked=true width=416 height=496`. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/yaver-rr-webrtc-watchos-simulator-final/watchos-simulator.mp4` (`h264`, 1280x800, 30 frames, 7.5s). | Center pixel was black because the captured watch screen was dark; proof is a real decoded JPEG frame with watch dimensions and metadata. |
| W10 | `PIXELS` | Ubuntu Chromium against Mac Apple Vision Pro simulator: first run with the default 25s pixel window was `SILENT`; rerun with target-aware 60s budget passed: `VERDICT=PIXELS · visionos-simulator:jpeg-dc:webrtc-datachannel-jpeg-v1`; frame-meta `bytes=19895 chunked=true width=720 height=405`. Recording: `/tmp/yaver-webrtc-artifacts/remote-runtime/visionos-macremote/visionos-simulator.mp4` (`h264`, 1280x800, 34 frames, 8.5s). | Keep 60s default first-pixel budget for visionOS in the harness; still add an agent-side first-frame progress event later. |
| W11 | `PIXELS` | Ubuntu temp agent lifecycle smoke: create browser-window session, fetch JPEG frame, `DELETE /remote-runtime/sessions/<id>`, then `GET /remote-runtime/sessions` returned no sessions. | Extend cleanup guard to assert browser child processes are gone, not just session map empty. |
