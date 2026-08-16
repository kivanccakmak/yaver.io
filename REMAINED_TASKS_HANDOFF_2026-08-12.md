# Remaining Tasks — Cross-Surface Vibe + opencode + Render/Transport Handoff (2026-08-12)

Written at the end of the 2026-08-12 session (tvOS vibe loop, opencode deep
audit, desktop opencode hub, web re-render parity, TURN, Unity-as-remote-PC)
for a FRESH session. House rules from AGENTS.md: fix the PRODUCT, probe the
operation not the inventory, name every failure, ship to every surface, prove
guards by breaking them. No IPs, tokens, passwords in this file — the repo is
public.

---

## 0. What shipped this session (committed + pushed — do NOT redo)

HEAD: `c46fff601` (pushed to github/main). Three commits on top of the
pre-existing `26807f2c0`:

| Commit | Content |
|---|---|
| `a634b1135` | **P5/P6/P2-lite**: VibeCodingView `runtime_render_requested` parity; TURN derived from RELAY_URL (F2) + relay deploy wiring; Unity as a generic remote-PC view (native-webrtc + desktop-screen target) |
| `8ebe9e4ed` | Pre-existing WSL2/ConPTY work that was sitting uncommitted: `pty_master.go` (+unix/windows), `windows_seat.go` (+stub/test), runner_pty/terminal_session/install_registry moved onto the interface |
| `c46fff601` | Pre-existing: watch + Live-Activity MARKETING_VERSION → 1.18.167; stale ATS comment trimmed; tvOS VibeTurnPanel `prefill` binding |

Earlier this session (`26807f2c0`, pushed): tvOS full vibe loop
(`createTask` mode/goal/askMode + `subscribeTaskOutput` SSE, TaskComposerView,
TaskDetailView, TasksView wiring); deep-audit everywhere (`audit` graph
template, askMode on mobile/MCP proxy/schema); desktop opencode hub
(OpenCodeSettingsView + electron tray deep-link); PreviewPane render parity.

Build/test status at handoff: `go build ./...` OK (desktop/agent); targeted
tests pass (`Unity|ExecutionMode|Turn|TURN|IceServers|ResolveTurn|
ResolveWorkspacePreview`); web `tsc --noEmit` clean; tvOS Simulator build green.
The FULL `go test .` in desktop/agent takes >10 min — run it, don't trust the
targeted subset alone.

---

## 1. Deploy status (what still needs to happen)

`./deploy/deploy.sh all` was the intended next step and was **NOT yet run** at
handoff (the working tree was being cleaned). Targets that still need a run
(owner-only, one path: `./deploy/deploy.sh <target>`):

- [ ] **convex / backend** — `./deploy/deploy.sh backend`
- [ ] **cloudflare / web** — `./deploy/deploy.sh cloudflare`
- [ ] **ios / testflight** — `./deploy/deploy.sh ios` (watch/live-activity now
      at 1.18.167 to match the parent)
- [ ] **android / playstore** — `./deploy/deploy.sh android`
- [ ] **npm / cli** — `./deploy/deploy.sh npm` (the Go agent: pty_master,
      TURN, Unity routing all ship in the binary)
- [ ] **mcp** — `./deploy/deploy.sh mcp`
- [ ] **tvos / watchos / wear / tv / carplay / visionos** — only if those
      surfaces need a build this cycle

NOTE: `deploy.sh all` requires the `yaver` CLI on PATH and a conservative
umask; it owns version bumps + clean-tree checks + release commits.

---

## 2. Genuinely remaining work (not done, not committed)

### 2a. P5 leftover — web paint-evidence (PREVIEW_READY_PREDICATE)
- The web dashboard has NO paint-evidence classifier for preview "live"
  (mobile has `mobile/src/lib/previewReadyScript.ts` /
  `PREVIEW_READY_PREDICATE`). `RuntimeLabView` reports `running=true` on a
  compile-failed-but-listening server → blank iframe under a green status.
- Port the mobile predicate to the web iframe lane (or at minimum surface the
  `runtimeCompileCard` earlier). See
  `docs/audits/webui-chat-vibing-gui-2026-08-12.md` §4.
- Parity rule: keep the predicate as a STRING module (like mobile) so tests
  evaluate the real injected bytes, and add the web twin test.

### 2b. TURN — verify end-to-end, not just unit
- `resolveTurnURL()` derivation is unit-tested; the RELAY side
  (`relay/main.go` `--turn-port` + `TURN_PUBLIC_IP`, secret fallback) exists.
- **Untested operationally**: nothing proves a phone-on-cellular →
  box-behind-NAT WebRTC session actually connects over the relayed TURN.
  Run `yaver doctor webrtc` (ICE doctor) against a live relay deploy and
  confirm it reports relay-ok instead of degraded. If the relay deploy
  doesn't set TURN_PUBLIC_IP, the new provision-relay.sh default covers new
  boxes only — existing relay hosts need the env added.

### 2c. tvOS — wire the new vibe loop into the e2e arc
- `TaskComposerView`/`TaskDetailView`/`subscribeTaskOutput` build and exist,
  but the tvOS closed loop (`e2e/tvos-sim-vibe-loop.mjs`, `TVWebPreviewLoopTests`)
  has NO arc that creates a task from the TV UI and asserts the live console
  streams. Add one (create → stream → assert raw bytes appear → done frame).
- `AgentClient.createTask` still lacks `goal` + `askMode` on the visionOS
  shared-client compile — visionOS shares AgentClient.swift, so it got the
  fields for free; confirm visionOS views don't break (it compiled in the
  tvOS build, but visionos/ has its own target).

### 2d. Mobile Ask toggle — UI exists, e2e does not
- The composer "Ask / Deep audit" toggle and `askMode` plumbing shipped;
  `taskRequestBody.test.mts` covers the body. No lane-matrix spec drives the
  toggle end-to-end (tap Ask → task arrives with askMode=true → answer
  returns grounded file:line cites). Add to
  `e2e/tests/mobile-app-lane-matrix.spec.ts`.

### 2e. Audit graph — report artifact + graph SSE
- `template:"audit"` exists (4-node chain writing audit-report.md/.json).
- Missing: `GET /agent/graphs/{id}/output` SSE (graphs are polled every 1.5s;
  mobile/tvOS have no graph panel at all). The audit-report artifact has no
  consumer surface yet (web renders node summaries only).

### 2f. Unity — treat as generic remote-PC, finish the honest edges
- Execution mode + preview strategy + desktop-screen target are in. Still
  stale/false-green (do NOT resurrect the SDK — owner deleted it 2026-08-02):
  - `desktop/agent/sdk_cmd.go:409` injects `"file:../../sdk/feedback/unity"`
    into Packages/manifest.json — dangling path, directory deleted.
  - Doctor text `desktop/agent/main.go:7661-7666` still claims a "Unity fast
    iteration path" that has no code behind it.
  - `desktop/agent/stack_detect.go:803-805` claims unity surfaces
    `mobile, web, tv, vision` — only the remote-PC view actually runs.
  - `web/app/docs/unity/page.tsx` + `web/app/docs/developers/page.tsx:225`
    present Unity as shipped ("Unity is now a real Yaver lane").
  - `desktop/agent/workspace_preview_strategy.go:349-350` stale
    "yaver-feedback-unity" package name (SDK deleted).

### 2g. Desktop opencode hub — yaver code control-plane + goal plugin
- OpenCodeSettingsView covers provider/model/key/add/delete. Still CLI/MCP
  only: `yaver code` control-plane (work-mode / attached-device / repo —
  `code_control.go:1192-1200`), and no goal-plugin install/enable UI
  (runtime `/goal` only, `VibeCodingView.tsx:3688-3691`).

---

## 3. Environment notes (from the audit, re-verify before trusting)

- tvOS docs drift: `docs/yaver-tvos-surface.md` §4 claims "No project
  selection / No results streaming" — both now exist. `SIGNAL_WIRING_MATRIX.md:50`
  claims tvOS adopted the `?since=` byte cursor — false.
- `FAILURE_PLUMBING_ARCHITECTURE.md:454-467` lists open tvOS false-greens
  (S4/S5/S7, D3/D4).
- WebRTC on iOS simulator: H.264 capture is dead (Xcode 26 removed
  recordVideo-to-stdout); iOS sims fall to ~18 s/frame JPEG
  (`remote_runtime_capture.go:5-9`). ScreenCaptureKit path not implemented.
- browser-window + redroid are JPEG-only (no RTP H.264).
- `yaver deploy all` from this Mac is the canonical path; iOS TestFlight has
  a documented local fallback (`APP_STORE_KEY_*` / `APPLE_TEAM_ID`) even when
  `yaver vault env --project mobile` is unauthenticated — see CLAUDE.md.
