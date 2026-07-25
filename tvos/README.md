# Yaver tvOS — native remote-runtime dashboard

> Status: **Apple TV App Store staged** (2026-07-05). Decision:
> `docs/yaver-tvos-fork-adr.md` (Option B — native SwiftUI, **no `react-native-tvos` fork**).
> This target builds and uploads through `scripts/deploy-tvos.sh`.

## Why this is separate from `mobile/`

Stock React Native + Expo cannot target tvOS, and the `react-native-tvos` fork would tax every
future `expo prebuild` / native overlay in `mobile/ios/` for a surface that is 90% touch-first
UI a Siri Remote can't drive. So Apple TV is a **small standalone SwiftUI app** that talks to a
Yaver agent over the **same** surfaces everything else uses:

- **Auth:** RFC 8628 device-code flow against Convex (`POST /auth/device-code`,
  `GET /auth/device-code/poll`) — identical to `mobile/src/lib/tvSignIn.ts` and `yaver auth`.
  The TV shows a QR + short code; an already-signed-in phone approves it.
- **Control:** direct LAN first, relay fallback when account settings provide relay
  metadata for the selected machine. Ops calls use `POST /ops` with
  `{ "verb": ..., "payload": ..., "machine": "local" }`
  and `Authorization: Bearer <session-token>` — identical in spirit to
  `mobile/src/lib/appletvClient.ts`. The same fallback is used for `/projects`, `/tasks`,
  `/feedback`, `/runner/session/turn`, `/droid/frame`, `/capture/frame.jpg`, and
  `/vibing/preview/*`, plus `/health`, so the picker does not say "connected" while the
  actual surface is LAN-only.

No new backend, no new agent code. The agent already serves every verb this app calls.

## Scope (lean-back runtime control — by design)

Shipped slice = the surfaces that are genuinely a 10-foot experience:

1. **Runtime control room** — machine status, dev-server status, Claude/Codex agent sessions,
   STT/TTS readiness, QR-based OAuth handoff, and hot-reload/Hermes-push controls
   (`info`, `status`, `runner`, `runner_auth`, `voice`, `reload`). Its Live Room band follows
   the shared `runtime_turns` queue so commands started from phone, watch, car, Android
   remote, or TV are visible on the television.
2. **Machine picker + wake** — account machines from `GET /devices/list`, selected-machine
   status, live-first auto-connect, shared-machine labels, and managed-box Wake.
3. **Projects + preview** — project list from `/projects`; web projects start through
   `POST /dev/start` and are captured headlessly through `/vibing/preview/*`; Android/RN
   previews watch the redroid frame stream.
4. **Live session** — `runtime_turn` when available, with `/runner/session/turn` fallback,
   so the TV can drive an existing Codex/Claude session and render the pane/options.
5. **Tasks and feedback** — glanceable task/session status and SDK feedback reports.
6. **Apple TV remote** — D-pad / transport / now-playing card (`appletv_*` verbs).
7. **Capture / now-playing** view of the home capture card (`capture_*`).

Dense code editing is still intentionally **not** on tvOS. The Apple TV is the wall
display/control surface while coding continues from MacBook terminal, Claude Code, Codex,
phone, or web. It can drive short prompts, choose session options, trigger reloads, and show
what the remote runtime is doing.

## QR auth handoff

Apple TV follows the same sign-in pattern users expect from streaming apps:

- Yaver account/runtime auth shows a QR plus a short code. The QR targets
  `https://yaver.io/auth/device?code=...`; the signed-in Yaver phone app opens
  the approver via Universal Links/App Links and authorizes the TV or remote
  machine.
- Claude Code and Codex auth is started on the selected runtime through
  `runner_auth browser_start`. tvOS renders the returned provider URL as a QR;
  the phone opens the system browser and completes OAuth/device-code handling.

The TV never asks for passwords, provider tokens, API keys, or long codes with
the Siri Remote. Watch, car, Android TV, and Android Auto should use the same
phone-mediated handoff shape.

## Transport note

This app connects direct-first: LAN host/port when available, then the relay HTTP proxy for
machines selected from the account registry. tvOS loads the user's relay URL/password from
`GET /settings`, attaches it to the cached `BoxTarget`, and uses the same endpoint builder for
ops, REST, stream frames, runtime turns, and health probes. tvOS still does not embed a Swift
QUIC client; the fallback is the same HTTPS relay proxy shape used by browser-friendly
endpoints. Manual "type an address" entries remain LAN-only because they have no account
relay row.

## Creating the Xcode target (one-time)

The repo intentionally does **not** check in an `.xcodeproj` (generated, churny) — it is
generated from `tvos/project.yml` by XcodeGen. Do **not** hand-build the target in Xcode;
edit `project.yml` instead.

```bash
cd tvos && xcodegen generate     # ALWAYS run this before a build or deploy
```

Because the `.xcodeproj` is gitignored and generated, a local one goes stale **silently**:
it keeps compiling whatever file list it was generated with, so a Swift file added by another
commit produces "cannot find X in scope" against code that is plainly on disk. Regenerating is
the fix, and it is cheap — make it reflexive.

Build & run on the tvOS Simulator or a real Apple TV. Sign-in: scan the QR with the Yaver
phone app, approve — the TV gets a 1-year session.

Submission mirrors the iOS path (App Store Connect, same team/API key), and the bundle id is
`io.yaver.mobile` — the **same** as the iPhone app, on purpose, so Apple treats TV/iOS/visionOS
as one Universal Purchase app record with separate per-platform build streams.

```bash
$(yaver vault env --project mobile)   # or: source ~/.appstoreconnect/yaver.env
./scripts/deploy-tvos.sh --upload
```

The build number is chosen for you: `--upload` asks App Store Connect for the highest existing
**TV_OS** build and uses that + 1 (`scripts/asc-next-build.sh` → `scripts/asc-max-build.py`).
`project.yml` pins `CURRENT_PROJECT_VERSION: "1"`, which is why this lookup matters — without
it every upload archives for minutes and is then rejected as a duplicate, burning a slot of the
~15-20/day TestFlight cap. Set `TVOS_BUILD_NUMBER` only to deliberately override, and it must
exceed the current ASC max.

## File map

| File | Role |
|---|---|
| `YaverTVApp.swift` | `@main` App; injects `YaverStore`. |
| `Backend.swift` | Convex origin + device-code auth (create + poll). |
| `AgentClient.swift` | `POST /ops` to a box over LAN HTTP, Bearer auth. |
| `Models.swift` | `Codable` for now-playing, capture status, devices. |
| `YaverStore.swift` | `@MainActor ObservableObject` — session token, selected box, persistence. |
| `Views/SignInView.swift` | QR + short code, polls until approved. |
| `Views/DashboardView.swift` | Lean-back tile launcher. |
| `Views/RuntimeDashboardView.swift` | Runtime control room: status, Claude/Codex sessions, voice, QR OAuth, reload, Apple surface readiness. |
| `Views/AppleTVRemoteView.swift` | D-pad / transport / now-playing. |
