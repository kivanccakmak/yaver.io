# TVOS Surface Synergy — Handoff (2026-08-21)

> Handoff for the NEXT session. This documents what this session did, the
> exact current state of the working tree, and what remains. **Do not trust
> memory — read the code before acting.** The audit doc is
> `docs/architecture/TVOS_SURFACE_SYNERGY_AUDIT.md`.

## STATUS: Phase A FOUNDATION COMPLETE (2026-08-21, second session)

The §4 blocker is resolved, the 8 viewer tests are green, creator attribution
is wired through the POST handler (with X-Yaver-Surface header fallback), the
tvOS client rejoins an existing live session by project instead of always
creating a second capture, and the stale docs are fixed. Details below; the
"Remaining" section now holds only the deferred Phase B/C items.

## 1. The product ask (v1 scope — now NARROWED)

Make **one shared vibing/chat session accept input from many client surfaces
of the SAME account** (no guests, no foreign users in v1):

- User vibes on the phone at home → leaves with the TV left open → keeps
  vibing from car / watch / desktop → returns home and the TV shows the
  **latest rendered state** of that same session + the turns that happened
  while away.
- "A tmux-alike vibing thing that has rendering + a vibing/chat session, and
  supports many client interfaces at once."
- Same-account only. The M15 guest watch-link and guest-TURN questions are
  **explicitly out of scope** (recorded in the audit doc §8).

The mental model that emerged mid-session: a **"vibe room"** — one live
capture (rendered left on the TV) + one shared turn feed (`runtime_turns`
+ task output, right) where every surface posts with `sourceSurface`
attribution. Watch/car join as **input + presence only** (no pixels by
design); TV/web/desktop/phone/headset join as **viewers + controllers + input**.
Apple TV's native AirPlay is NOT the path — it is one-way and uncontrolled;
Yaver's value is the interactive shared room. Full design in the audit doc §5.

## 2. What this session ACTUALLY did

### 2.1 Committed audit doc (new, untracked)
`docs/architecture/TVOS_SURFACE_SYNERGY_AUDIT.md` — full capability matrix,
the 5 synergy cases, the 6 load-bearing gaps (with `file:line`), the "Vibe
Room" composite layout (§5), the every-surface role table (§5.1), the
no-guests-v1 guardrail (§8), and the phased plan (§6).

### 2.2 Stale-doc correction (found, NOT yet fixed in docs)
`client_render_capabilities.go:13,119` and `VIBING_STATUS.md` claim
tvOS/visionOS ship **ZERO WebRTC client code**. **That is false today**: the
tvOS app builds a real WebRTC viewer via **LiveKitWebRTC +
`LKRTCMTLVideoView` (Metal)** at `tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift:906`.
The frames-lane-only constraint on TV is lifted. **Fix these docs in the same
change that lands the feature** (audit §3.6).

### 2.3 Phase-A agent foundation (COMPLETE 2026-08-21, second session)
The joinable-session foundation lives in `desktop/agent/`:

| File | State | What it adds |
|---|---|---|
| `remote_runtime_viewers.go` | **new, DONE** | Viewer registry (`viewers map[string]*remoteRuntimeViewer` keyed by clientId), `registerViewerLocked` / `unregisterViewerLocked` / `viewerCountLocked` (webrtc peers + fresh frame-pollers, 15s fresh window), `sendEventJSONLocked` (locked-core broadcast — the §4 deadlock fix), `stampViewerCount`, `latestPeerLocked`, `leaveViewer` (refcounted leave; last-viewer teardown). |
| `remote_runtime_viewers_test.go` | **new, DONE — green** | 10 tests: count, stamp, joined-event broadcast, refcounted-leave survival (THE guard), last-viewer closes, unknown-viewer no-op, unknown-session error, roster counts+filters, creator attribution, anonymous-create legacy shape. **Guard proven by breaking it.** |
| `remote_runtime.go` | modified, DONE | DTO: `ViewerCount`/`StartedBy`/`SourceSurface`; `CreateWith` (+ `remoteRuntimeCreator{ClientID, Surface}`) seeds creator viewer at create; `sourceSurfaceForCreator` keeps legacy anonymous creates empty; roster GET `?project=&device=` filtering + `stampViewerCount`; POST handler accepts `clientId`/`surface` and falls back to the `X-Yaver-Surface` header. |
| `remote_runtime_webrtc.go` | modified, DONE | `viewers` field on `remoteRuntimeLiveState`; offer request carries `clientId`/`surface` → registers viewer; `/frame` GET `?clientId=` registers frame-poll viewer; `/leave` route; DELETE stays force-stop; peer teardown unregisters viewer + broadcasts `viewer_left`. |
| `remote_runtime_dispatch.go` | modified, DONE | `/leave` added to `splitSessionRoutePath` (proxied-builder forwarding). |

tvOS client (this session): `AgentClient.listRemoteRuntimeSessions(project:)`
(GET roster), creator attribution on create (`clientId` = stable TV install id,
`surface` = Backend.surface), and **rejoin-first** in
`RemoteRuntimeWebRTCView.start()` — poll the roster, attach to a live session
for the project instead of creating a second capture. `RemoteRuntimeSession`
gained `viewerCount`/`startedBy`/`sourceSurface` (optional, decode-safe).

Docs fixed in the same change: `client_render_capabilities.go:13,119`,
`VIBING_STATUS.md`, `docs/native-webrtc-web-streaming.md` (fan-out row #10).


## 3. Current git state (run `git status --short` to confirm)

All of the following is THIS session's work and is staged/committed together
(second session, 2026-08-21 — the earlier "concurrent session" split no
longer applies; the tablet Vibe Studio and the viewer registry are now one
commit):

```
 M desktop/agent/client_render_capabilities.go   (doc fix)
 M desktop/agent/remote_runtime.go               (creator wiring + header fallback)
 M desktop/agent/remote_runtime_dispatch.go      (/leave forwarding)
 M desktop/agent/remote_runtime_webrtc.go        (viewer registry + locked-core broadcast)
 M mobile/app/(tabs)/more.tsx                    (Vibe Studio entry, tablet-only)
 M mobile/src/lib/quic.ts                        (X-Yaver-Surface marker)
 M tvos/YaverTV/AgentClient.swift                (roster GET + creator attribution)
 M tvos/YaverTV/RemoteRuntimeModels.swift        (viewerCount/startedBy/sourceSurface)
 M tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift (rejoin-first + dims passthrough)
 M web/lib/surfaceViewports.ts / .test.ts        (tabletLandscape surface)
 M VIBING_STATUS.md, docs/native-webrtc-web-streaming.md
?? TABLET_VIBE_STUDIO_PLAN.md                    (tablet studio plan + audit)
?? TVOS_SURFACE_SYNERGY_HANDOFF.md               (this file)
?? desktop/agent/remote_runtime_viewers.go       (new — viewer registry)
?? desktop/agent/remote_runtime_viewers_test.go  (new — 10 tests, green)
?? docs/architecture/TVOS_SURFACE_SYNERGY_AUDIT.md
?? e2e/tests/tablet-vibe-studio.spec.ts           (new — tablet split/peek arc)
?? mobile/app/vibe-studio.tsx                    (new — tablet studio screen)
?? mobile/src/components/studio/                 (new — StudioChatPane + LivePreviewPane)
```

`go build ./...` in `desktop/agent/` is GREEN; viewer + creator + remoteless
tests pass; tvOS builds (simulator, `CODE_SIGNING_ALLOWED=NO`); mobile `tsc`
clean for the new files; web surfaceViewports tests pass.

> Known pre-existing flake (NOT this change): `go test .` for the FULL main
> package times out on `TestCustodianAbandonsAHangingWarden` in the full-suite
> context (passes in isolation; reproduced on clean HEAD via worktree).

## 4. THE BLOCKER — RESOLVED (2026-08-21, second session)

The blocker was **not** a stale build cache or a second struct definition —
`type remoteRuntimeLiveState` exists exactly once (line 36) and the `viewers`
field sits inside it (line 89). The real bug: `registerViewerLocked` /
`unregisterViewerLocked` are documented "caller holds live.mu" but called
`sendEventJSON`, which **locks live.mu again** → self-deadlock the moment a
viewer registered (test `TestViewerCount_CountsWebRTCAndFreshFramePollers`
hung until the Go test timeout). Fixed by splitting `sendEventJSON` into a
locking wrapper + a `sendEventJSONLocked` core (same-package, no re-lock), and
pointing the two viewer-registry broadcasts at the locked core. The hot paths
(frame pumps) keep the unlocking `sendEventJSON` unchanged.

Also fixed two test bugs that blocked compilation/pass (this test file had
never compiled before):
- `TestRegisterViewer_BroadcastsJoinedEvent` compared `float64(1)` against an
  `int` count in the raw backlog map → compare `1`.
- `TestRoster_ReturnsViewerCountsAndFilters` called `mgr.List()` and expected
  stamped counts, but the HTTP handler stamps (`remote_runtime.go:1928-1937`);
  the test now stamps via `mgr.stampViewerCount` per entry, mirroring the GET
  contract.

Guard proven by breaking it: `TestLeaveViewer_SecondViewerSurvives` passes
with the refcount intact and fails with `session closed after one of two
viewers left — refcount broken` when `leaveViewer` is forced to treat every
leave as the last. Restored after the proof.

## 5. What remains (deferred — do NOT start without a fresh ask)

### Phase A tvOS client (optional polish, NOT the v1 ask)
- `VibingView` "live sessions on this box" rail → attach by id. (The rejoin
  path is already in `RemoteRuntimeWebRTCView.start()`; a dedicated rail that
  lists live rooms is polish.)
- `RemoteRuntimeWebRTCView` takeover affordance ("another viewer took over").

### Phase B / C (deferred)
- Desktop-PC → TV screen mirror surfacing.
- Watch/TV presence attribution; Android TV placeholder screens.

### Verification recipe for the next session
> The viewer registry + creator attribution are DONE and green. If you touch
> this code again, re-run:
> - `cd desktop/agent && go build ./...` then
>   `go test -run 'TestViewerCount|TestRegisterViewer|TestLeaveViewer|TestRoster|TestCreateWith' -count=1 .`
> - `go test -run 'RemoteRuntime|VibePreview' -count=1 ./desktop/agent/`
> - `cd tvos && xcodegen generate && xcodebuild -project YaverTV.xcodeproj -scheme YaverTV -sdk appletvsimulator build CODE_SIGNING_ALLOWED=NO`
> Note: `go test .` for the FULL main package times out on a pre-existing
> test-order flake (`TestCustodianAbandonsAHangingWarden` hangs in the full
> suite context but passes in isolation) — present on clean HEAD too, not a
> regression from this change.

## 6. Rules to respect
- **Do not commit or push without explicit user permission.** (This session:
  user granted permission to commit + push + deploy.)
- No guests/cross-account work in v1. Same-account only. Same-box lease only
  (no Convex fleet lease).
- When the doc and the code disagree, the code wins — and fix the doc in the
  same change.
