# tvOS ↔ Every-Surface "Vibing Together" Synergy Audit

Date: 2026-08-21. Code is source of truth; re-grep every `file:line` before
relying on it. This audit answers one product question: **how do groups of
people vibe on the same live app session together** — mobile + Apple TV,
Apple TV + desktop PC, watch + tvOS, Android phone + tvOS, Android TV + iOS,
and a roomful of people on one SFMG (or any) live session?

## 0. Headline

**The server can already broadcast; the clients can't share.**

The Go agent has genuine multi-viewer primitives — WebRTC RTP fan-out on one
shared track, SSE + content-addressed frame fan-out, a refcounted per-source
encoder, and RTMP egress. But every client surface creates its own *private*
session and nothing can join someone else's live screen. The whole
"vibing together" ask collapses to one missing primitive: **a joinable,
addressable, presence-bearing shared live session** — plus one stale belief
blocking the TV lane (see §3.6).

## 1. Capability matrix (measured from code)

| Surface | Watches live screens | Controls remote app | Pushes own screen | Shared session |
|---|---|---|---|---|
| **tvOS** (`tvos/`) | Yes — 3 lanes: `/vibing/preview/*` frames, WebRTC (`RemoteRuntimeWebRTCView.swift`), `/droid/frame` | Yes — D-pad overlay + DOM cursor through the single-writer `ControlLease` | **No** — `recvOnly` transceiver only (`RemoteRuntimeWebRTCView.swift:1397`) | **No** — always POSTs a new session; preview is a per-project *lock* |
| **visionOS** (`visionos/`) | Frames + droid only — shares `WebPreviewStreamView`/`DroidStreamView` (`visionos/project.yml:79-100`); **no WebRTC view** | Reload + session turns | No | No |
| **watchOS / Wear** (`watch/`, `wear/`) | **Nothing visual** — voice/haptic membrane by design | Voice turn / approve | No | Work-level only (`runtime_turn`) |
| **Android TV** (`androidtv/`) | **Placeholders** — vibing/preview/droid/session routes render "Under construction" (`ui/PlaceholderScreens.kt:166-184`) | No | No | No |
| **Mobile** (`mobile/`) | WebRTC (direct) / relay-JPEG poll | Yes (tap/swipe/text/key) | Camera→box via `/stream/push` (M10, `cameraStreamClient.ts`) | **No** — `getRemoteRuntimeSession(sessionId)` is dead code (`src/lib/quic.ts:4299`) |
| **Web dashboard + Electron** (`web/`, `electron/`) | WebRTC (RTP / JPEG-DC / relay-poll) | Yes but **sends no `clientId`** — can never hold the lease; no takeover UI (`RemoteRuntimeViewer.tsx`) | Electron shell: **no** capture; the embedded Go agent is the screen source (`desktop-screen` target, `remote_runtime_desktop.go`) | No |
| **Agent backend** (`desktop/agent/`) | — | `ControlLease` (≤1 controller, 60s idle-steal, `remote_runtime_lease.go`) | `desktop-screen`, sim/emulator/redroid, capture card, **pushed phone** | **Multi-viewer RTP fan-out** (`remote_runtime_webrtc.go:339-405`); **multi-subscriber frame SSE** (`vibe_preview.go:1256`) |

## 2. The five synergy cases, judged against reality

### ① Mobile + Apple TV vibing the same app (the SFMG case)

- **Reality:** the vibe-preview lane is a per-project *exclusive lock* —
  `vibe_preview.go:389` "One session per project — caller must Stop before
  re-Starting"; a second `POST /vibing/preview/start` returns 409
  `PreviewSessionActiveError` (`vibe_preview.go:399`). The TV's only offered
  route is the takeover fix `previewSessionActiveGap` → **"Stop it and take
  over"** (`vibe_preview_takeover.go:144,169`), which stops the phone's session.
  If the TV instead starts the interactive `RemoteRuntimeWebRTCView`, it POSTs a
  **new** remote-runtime session (`RemoteRuntimeWebRTCView.swift:1060`) — a
  second capture of the same app, not a mirror.
- **What already works underneath:** the *read* side fans out. SSE subscribers
  each get a channel in a `map[string][]chan` fan-out (`vibe_preview.go:1256`)
  and can fetch any content-addressed frame (`/vibing/preview/frames/<hash>`).
  On the remote-runtime lane, an RTP offer against an existing session *attaches*
  as an additional subscriber to the same track (`remote_runtime_webrtc.go:339-357`),
  verified by `TestApplyWebRTCOffer_FansOutToSecondViewerWithoutTearingDownFirst`.
- **The gap:** no subscribe-without-owning path, no refcounted leave, no
  takeover affordance on the TV, no presence.

### ② Apple TV + desktop PC (macOS / Windows / Linux)

- **Reality:** a desktop PC is two things already:
  - an **Electron viewer** (`electron/src/main.js:34-35` loads the live web
    dashboard) — the web `RemoteRuntimeViewer` negotiates WebRTC but posts
    controls with **no `clientId`**, so it can never *hold* the lease and is
    rejected server-side whenever another surface drives
    (`remote_runtime_lease.go:94-117`);
  - an **embedded Go agent** (`electron/src/agent-manager.js:194-304`) that can
    stream **its own desktop screen** to other surfaces via the
    `desktop-screen` target — ffmpeg grab → Annex-B H.264 straight into the
    shared RTP pump (`remote_runtime_desktop.go:273-333`), reachable from the
    web Runtime Lab (`RuntimeLabView`).
- **So:** PC→TV screen mirroring is technically possible today (RTP fan-out), but
  nothing surfaces it as "mirror this PC to the TV", and the TV has no
  join-by-id path to attach to a session the PC's agent created.

### ③ Watch + tvOS

- **Reality:** already half-there at the **work** level. The watch drives the
  live runner session by voice (`/runner/session/turn`) and nudges the shared
  `runtime_turn` queue (`ops_runtime_turn.go`). tvOS's Live Room renders the
  same `runtime_turns` feed — "Phone, watch, car, Android remote, and TV all
  point at the same runtime" (`tvos/YaverTV/Views/RuntimeDashboardView.swift:42-74`).
- **The gap:** **presence**. The TV shows the turn but not *who* started it
  (`sourceSurface` is in the payload but not rendered as an attribution), and
  the watch gets no "the TV is now watching your session" signal. A watch
  cannot see pixels by design — that is correct and should stay.

### ④ Android phone + tvOS / Android TV + iOS

- **Reality:** the client platform mix is already symmetric — the mobile RN app
  is Android+iOS; the tvOS app has an Android TV twin (`androidtv/`) but its
  vibing/preview/droid/session routes are **placeholder screens**
  (`androidtv/README.md:19-21`, `ui/PlaceholderScreens.kt:166-184`). Redroid /
  physical-Android frames already render on the TV (`DroidStreamView.swift`
  polls `GET /droid/frame`).
- **The gap:** same shared-session join, not a platform issue. Android TV needs
  the same HTTP-frame + WebRTC contract tvOS has (Phase C parity work).

### ⑤ Group of people vibing together on SFMG (watch party)

- **Reality:** two honest paths exist but are not surfaced as "watch together":
  1. **M15 stream lane** — one source (capture card / screen / scene / pushed
     phone) → N WebRTC viewers via a refcounted shared encoder
     (`stream_webrtc_fanout.go:36-77`; one ffmpeg per `source:tier`, last viewer
     stops it). Plus **RTMP broadcast-out** (`broadcast.go:48`) for a genuinely
     public roomful of people, and a guest watch link ("Create link" →
     `/watch#…`, no controls).
  2. **Vibe-preview frame lane** — one headless-Chrome capture, N SSE
     subscribers (`vibe_preview.go:1256`).
- **The gap:** no roster, no viewer count, no share link to an *existing*
  session, no "N devices watching" signal anywhere.

## 3. The load-bearing gaps (each blocks "together")

1. **No join-by-session-id.** `RemoteRuntimeSession.id` exists and the agent's
   offer endpoint already attaches additional RTP viewers to an existing session
   (`remote_runtime_webrtc.go:339-357`), but no client lists or joins existing
   sessions. tvOS always `POST /remote-runtime/sessions`
   (`RemoteRuntimeWebRTCView.swift:1060`); mobile's join API is dead code
   (`src/lib/quic.ts:4299`, sole match is the definition itself).
2. **Preview sessions are single-owner / single-holder.**
   `vibe_preview.go:389` — one session per project; a second surface gets the
   409 + "stop it and take over" takeover route (`vibe_preview_takeover.go:144`)
   instead of a subscribe. And `WebPreviewStreamView` calls `stopWebPreview` on
   `.onDisappear` (`WebPreviewStreamView.swift:252-256`) — destructive when
   another surface wants the session.
3. **JPEG-DC transport kills prior peers.** A JPEG-data-channel offer closes any
   existing peer (`remote_runtime_webrtc.go:344-347`); the relay-JPEG-poll phone
   mode is per-viewer capture, so phone + TV watch two captures of the same app.
4. **Control lease is in-process only.**
   `remote_runtime_lease.go:22-25`: "Deliberately in-process only: the goal is
   arbitration among the clients this agent is serving, not a distributed lock.
   Relay-bus registry (also P5) is what makes the lease *visible* across a
   user's fleet; that lands separately." Phone on box A + TV on box B =
   last-writer-wins, no takeover prompt.
5. **No presence / roster.** No viewer count on the wire, no "who is watching"
   on any surface. `vibe_sessions.go` holds session/participant data for
   resource attribution with **no tvOS/web/mobile consumer**.
6. **Stale docs actively lie about the TV lane.**
   `client_render_capabilities.go:13,119` and `VIBING_STATUS.md` claim
   tvOS/visionOS ship **ZERO WebRTC client code**. The tvOS app now builds a
   real WebRTC viewer — **LiveKitWebRTC + `LKRTCMTLVideoView` (Metal decode)**
   (`tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift:14,906-907`). The
   frames-lane-only constraint on TV is **lifted**; anyone planning against the
   docs will build the wrong lane. visionOS, however, genuinely has no WebRTC
   view (its `project.yml` pulls only the frame/droid views).

## 4. What already exists (the reusable substrate)

- **Multi-viewer RTP fan-out** — shared `videoTrack`/`videoPump`, per-peer
  teardown (`remote_runtime_webrtc.go:26-53, 242-318, 339-357`); events
  broadcast to all peers via `sendEventJSON`. Tested:
  `TestApplyWebRTCOffer_FansOutToSecondViewerWithoutTearingDownFirst`
  (`remote_runtime_webrtc_test.go:268`).
- **Multi-subscriber frame SSE** — content-addressed immutable frames, ring +
  disk, non-blocking fan-out (`vibe_preview.go:1256-1277`).
- **Single-writer control arbitration** — `ControlLease`
  (`remote_runtime_lease.go:34-146`), plus MCP verbs `runtime_take_control` /
  `runtime_release_control` / `runtime_lease_status` (`httpserver.go:13958-14009`).
- **Refcounted broadcast encoder** — the M15 stream lane
  (`stream_webrtc_fanout.go`).
- **Host-screen capture** — `desktop-screen` target
  (`remote_runtime_desktop.go`).
- **Pushed-phone source** — `/stream/push` JPEG buffer (`stream_push.go:67`).
- **BlackBox command fan-out** — device-directed reloads / broadcast commands
  (`blackbox.go:321`), the same primitive that drives reload-to-N-devices.

## 5. The "Vibe Room" — composite, not mirror

An Apple TV already ships AirPlay screen-mirroring, so "stream the phone to
the TV" is a solved baseline problem — and a dead end. AirPlay is a **one-way,
uncontrolled, single-source mirror**: the phone's screen, no D-pad driving, no
second input, no presence, no cross-surface chat, no viewer-count. Yaver should
not compete with AirPlay; it should offer the thing AirPlay structurally cannot:
a **shared, interactive, multi-input workspace** rendered on the TV.

The target layout (a real vibe room, same-account first):

```text
┌─────────────────────────────┬──────────────────────────────────┐
│  LEFT — THE APP (render)    │  RIGHT — THE ROOM (chat/feed)    │
│                             │                                  │
│  one shared live capture    │  a live multi-input turn feed:   │
│  (frames lane or WebRTC     │  phone · web · watch · TV ·      │
│  fan-out) — same pixels on  │  desktop all post to ONE         │
│  every surface              │  `runtime_turns` queue; each     │
│                             │  turn attributed to its surface. │
│  anyone can "take over"     │  task output streams beneath,    │
│  via the single-writer      │  so the room shows ask → code →  │
│  lease; D-pad drives it     │  render → "ready to test".       │
└─────────────────────────────┴──────────────────────────────────┘
```

Why this is the right shape:

1. **The two halves already exist and are already shared.**
   - Left: the remote-runtime multi-viewer capture (§1) and the vibe-preview
     frame SSE (`vibe_preview.go:1256`) are both fan-out reads.
   - Right: `runtime_turns` (`ops_runtime_turn.go`) is the cross-surface
     utterance queue — phone/watch/car/TV/SDK all land in it today, and
     tvOS's Live Room already renders it (`RuntimeDashboardView.swift:42-74`).
   The missing piece is **compositing them into one screen with one session
   identity and a roster**, plus join/leave/presence so the room is legible.

2. **Many-input chat is the differentiator, not the render.** A room where
   "the app renders left and every surface can submit right" is the product
   sentence. The render alone is AirPlay; the render *plus* the shared,
   surface-attributed turn feed is Yaver. Each turn must carry
   `sourceSurface` so the TV can show who asked.

3. **Control follows the render, not the source device.** The TV's D-pad
   drives the *capture* (via `ControlLease`), so anyone in the room can take
   over regardless of which device started the session. AirPlay cannot do
   this: the mirror is glued to the source phone.

4. **AirPlay stays as a user choice, not a Yaver path.** Nothing in Yaver
   should try to replicate native mirroring (HDCP, DRM, one-way). Yaver's
   lane is interactive + shared + attributed; AirPlay is "show my phone
   exactly as-is". Both are honest; Yaver's value is the room.

### 5.1 Every surface joins the room, at its own capability level

The room is the unit, not the render. A device does not need to draw pixels
to be *in* the vibe room — it needs a role:

| Surface | Joins as | Sees in the room | Contributes |
|---|---|---|---|
| **TV / projector** | viewer + controller + input | left render + right feed + roster | D-pad drives capture; dictation posts turns |
| **Phone / tablet** | viewer + controller + input | full room + private detail | posts turns; drives; screenshots; approves |
| **Web / Electron desktop** | viewer + controller + input | full room | posts turns; drives; screenshots |
| **visionOS / headset** | viewer + input | spatial panels (render + feed) | voice/gaze posts; drive via gaze |
| **Watch / Wear** | input + presence (no pixels) | status + haptics + TTS; "N watching", "ready to test" | posts turns by voice; approves |
| **Car / CarPlay / Auto** | input + presence (no pixels, no code read) | one spoken line + status | posts turns by voice, hands-free |
| **Companion CLI / MCP** | input | task/queue rows | posts turns, automates, reads state |

So the presence model is richer than "viewer count": a room has **viewers**
(attach to the render) and **participants** (join the turn feed + presence
without a pixel path). The roster the TV shows should say both —
"Kivan · phone (driving) · friend · desktop (watching) · Serhat · watch (in)".
A watch that cannot render still matters to the room: it can ask, approve,
and be told "ready — it's on the TV".

## 6. Product flow after the fix (target state)

**SFMG vibe room — mobile + Apple TV + a friend's desktop:**
1. Kivan starts vibing SFMG on the phone (or the box captures it headlessly).
2. The TV's Vibing view lists "Live sessions" instead of forcing a new capture;
   the TV attaches to Kivan's session by id — one capture, N viewers, same
   pixels on every surface.
3. The TV renders the **vibe room**: SFMG left, the shared `runtime_turns`
   feed right — every message tagged with its surface ("Kivan · phone",
   "friend · desktop"). The phone shows a quiet "TV is watching · Desktop is
   watching" presence chip with a viewer count; the session carries
   `viewerCount` + `startedBy` + a roster.
4. Anyone can submit into the room from their own surface; anyone can tap
   "Take over" (arbitrated by the in-process lease, 60s idle steal); the lease
   holder sees a "Kivan is driving" note.
5. Leave is refcounted: TV backs out, phone keeps the session alive.
6. The watch says "Ready — it's on the TV" when the reload lands
   (`runtime_turn_verify` + BlackBox delivered-count already exist).

## 6. Implementation plan (agreed scope: same-box lease; all three use cases in sequence)

### Phase A — Make live sessions joinable (the foundation)

Agent (`desktop/agent/`):
- Roster verb: `GET /remote-runtime/sessions?project=&device=` → live sessions
  with `id`, `project`, `targetLabel`, `viewerCount`, `startedBy`,
  `sourceSurface`.
- Presence: `viewer_joined` / `viewer_left` broadcast on the session's `events`
  DataChannel (`sendEventJSON`); surface `viewerCount` on the DTO.
- Refcounted lifecycle: `POST /remote-runtime/sessions/{id}/leave`; tear down
  only when the last viewer leaves (reaper already handles abandonment).
- Preview-lane parallel: allow an owner to *subscribe* to an active
  `/vibing/preview/*` session (frames + SSE) instead of the 409 dead-end; keep a
  single capture owner.
- Fix the stale docs (`client_render_capabilities.go`, `VIBING_STATUS.md`) in
  the same change.

tvOS:
- `VibingView`: "Live sessions on this box" rail → attach to an existing
  session id (offer to it, don't create).
- `RemoteRuntimeWebRTCView`: leave ≠ delete on disappear; "Phone is driving —
  take over?" affordance wired to `runtime_take_control`.

Mobile:
- Use the dead `getRemoteRuntimeSession` (`quic.ts:4299`); presence chip when a
  TV joins.

Web / Electron:
- `RemoteRuntimeViewer.tsx`: send a `clientId`; drive/stop-driving toggle +
  takeover prompt.

Tests:
- Extend `remote_runtime_webrtc_test.go`: attach-without-teardown (pattern
  exists), refcounted leave, presence events.
- Closed-loop Go test: phone starts → TV joins → TV takes over → phone sees
  presence + lease change.

### Phase B — Desktop PC + TV screen mirror

- Surface the existing `desktop-screen` source as "Mirror this PC to TV" in the
  dashboard / Runtime Lab target list; TV join-by-id path sees it in the roster.
- Phase A's `clientId` + lease fix means the desktop doesn't lose every lease
  fight.

### Phase C — Watch + TV presence, then Android TV parity

- TV Live Room shows *who* started each `runtime_turn` (render `sourceSurface`);
  watch gets "Ready to test on TV" readback.
- Implement the `androidtv/` placeholder vibing/preview/droid/session screens on
  the same HTTP-frame + WebRTC contract as tvOS.

## 7. Verification (per AGENTS.md)

- **Headless first:** `go test ./desktop/agent -run 'RemoteRuntime|VibePreview|ClosedLoop'`;
  `cd tvos && xcodegen generate && xcodebuild -project YaverTV.xcodeproj -scheme YaverTV -sdk appletvsimulator build`.
- **Closed loop:** real phone + Apple TV on the same box session; prove pixels +
  lease handoff.
- **Break the guard:** disable the refcount, watch the leave test fail; restore.

## 8. Scope guardrails

- **Same-account only, no guests — v1.** Every surface that joins a vibe room
  is the same Yaver account; there is no guest/companion/foreign-user
  participant in v1. This keeps the roster, lease, and control all
  owner-scoped: the existing bearer-token auth already authorizes every
  joining surface, the in-process `ControlLease` is the only arbitration, and
  no cross-account presence/authorization work is needed. (The M15 guest
  watch-link and the deferred guest-TURN question from WEBRTC_LANE_DEEP_AUDIT
  are explicitly out of scope for the room feature.)
- Same-box lease only this round (no Convex fleet lease; the deferred registry
  at `remote_runtime_lease.go:22-25` stays deferred).
- No deploy without explicit user approval.
- Fix the stale docs in the same commits that make their claims obsolete.
- Never weaken the multi-tenant relay boundary; sessions stay owner-scoped.
