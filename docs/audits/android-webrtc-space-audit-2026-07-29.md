# Android WebRTC Space Audit — 2026-07-29

## Scope

Question: can this MacBook Air make room for the Android WebRTC gaps after the
closed-loop browser + Apple simulator pass?

Topology under test:

- Remote/runtime box: this MacBook Air.
- Browser client: Ubuntu 4GB over Tailscale/SSH.
- Existing closed-loop result: Apple simulator/browser lanes produced pixels;
  Android lanes were named gaps, not silent failures.

## Disk and Toolchain State

Measured on this Mac after WebRTC artifact cleanup:

- Data volume: `460Gi` total, `408Gi` used, `24Gi` available, `95%` capacity.
- Yaver WebRTC proof artifacts retained:
  `/tmp/yaver-webrtc-artifacts/autorun/mac-remote-ubuntu-client` = `1.4M`;
  `/tmp/yaver-webrtc-artifacts/autorun/mac-rtp-ubuntu-client` = `308K`.
- Xcode simulator data: `~/Library/Developer/CoreSimulator` = `8.7G`.
- Android Studio SDK: `~/Library/Android` = `12G`.
- Yaver-managed Android SDK: `~/.yaver/runtimes/android-sdk` = `6.7G`.
- Android AVD data: `~/.android/avd` = `4.6G`.
- Gradle cache: `~/.gradle/caches` was not present/readable in this pass.

Android tools observed:

- `adb`: `~/.yaver/runtimes/android-sdk/bin/adb`.
- `emulator`: `~/.yaver/runtimes/android-sdk/bin/emulator`.
- `avdmanager`: `/opt/homebrew/bin/avdmanager`.
- `sdkmanager`: `/opt/homebrew/bin/sdkmanager`.
- `ffmpeg`: `/opt/homebrew/bin/ffmpeg`.
- `scrcpy`: not found.

## Findings

1. There is enough disk to create one lean Android phone AVD, but not enough
   slack to install every Android specialty image casually. Keep at least
   15-20Gi free while running Xcode simulators plus an Android emulator; this
   Mac currently has about 24Gi free.

2. The previous autorun Android result was partly a harness environment issue:
   the temporary Mac agent was started with `HOME=/tmp/yaver-webrtc-home-mac`.
   Android AVD discovery is home-relative, so that agent could not see
   `~/.android/avd` and correctly returned `no AVDs configured`.

3. This user home has AVD entries:
   `Medium_Phone_API_36.0`, `fgs`, and `fgs2`.
   `emulator -list-avds` lists them.

4. `avdmanager list avd` reports all three AVDs as unloadable. The configs are
   split across two SDK roots:
   `fgs`/`fgs2` point at `~/.yaver/runtimes/android-sdk/system-images/android-35/...`;
   `Medium_Phone_API_36.0` points at
   `~/Library/Android/sdk/system-images/android-36/google_apis_playstore/...`,
   but that system image directory is absent.

5. The product had a false-green in `doctor surfaces`: it marked
   `android-emulator` available when `adb` existed, while a real session needs
   `emulator -list-avds` plus at least one AVD with its system image installed.
   This audit fixes that probe so the UI/CLI names the route before WebRTC
   session creation.

6. The same product pass exposed a tvOS false-negative: the available tvOS
   simulator is named `YaverTV-AppStore-1080p`, not `Apple TV`, so a string
   search over device names reported tvOS unavailable. The surface doctor now
   reads simulator runtime sections and treats any available device under the
   `tvOS` section as a tvOS device.

7. The broader Android specialty lanes need actual surface-specific AVDs or
   devices:
   Android Wear needs a Wear OS AVD, Android TV needs an Android TV/Google TV
   AVD, Android Auto needs an emulator plus Desktop Head Unit wiring, Android XR
   needs an XR/Quest-capable target, and Redroid needs a Linux host/container
   path rather than this macOS host.

8. Warm Android phone WebRTC against the `fgs` AVD attached and negotiated ICE,
   but returned `SILENT`: the viewer had a video element and
   `webrtc-rtp-h264-v1` ready event, with no pixels. Direct operation probe
   found the cause: `adb exec-out screenrecord --output-format=h264 ... -`
   exited `0` and wrote `0` bytes on this Android ATD image. The product must
   not select RTP H.264 from adb inventory alone.
9. After forcing Android emulator/device targets through JPEG-DC, the same
   Mac-remote / Ubuntu-browser closed loop passed:
   `SUMMARY pixels=2 named=0 silent=0`, with
   `android-emulator:jpeg-dc:webrtc-datachannel-jpeg-v1`.

## Space Plan

Recommended local plan:

- Do not delete the existing WebRTC proof recordings; they are below 2MiB.
- Shut down Apple simulators when running Android WebRTC to free RAM/CPU, not
  disk. The prior pass left iOS, iPadOS, watchOS, tvOS, and visionOS booted.
- Keep the Yaver-managed Android SDK as the primary SDK root for the agent.
- Recreate or repair only one phone AVD first, preferably API 35 arm64 with
  `google_atd` or `google_apis`, because the matching system images already
  exist under the Yaver-managed SDK.
- Defer Wear/TV/Auto/XR images until the phone Android WebRTC lane produces
  pixels. Installing every specialty image can consume multiple GiB each and
  will leave too little headroom on a 24Gi-free Mac.

## Product Hardening

Changed:

- `desktop/agent/doctor_surfaces.go` now probes the Android emulator lane by
  checking `adb`, `emulator`, `emulator -list-avds`, and each AVD config's
  `image.sysdir.1` against discovered Android SDK roots.
- `desktop/agent/doctor_surfaces.go` now detects Apple simulator devices from
  `simctl` runtime sections, not only from default device names.
- `desktop/agent/remote_runtime_capture.go` now keeps Android emulator/device
  targets on the JPEG-DC WebRTC path by default. H.264 can return later only
  after the agent probes real screenrecord bytes and falls back when the byte
  stream is empty.

Expected behavior after this change:

- No AVDs visible under the agent's `HOME` is reported as:
  `no AVDs configured — run avdmanager create avd ... or yaver install remote-runtime`.
- Stale AVD configs are reported with the exact `sdkmanager` package needed.
- A loadable AVD is reported as available before the WebRTC picker advertises
  Android emulator as healthy.
