# SESSION_HANDOFF_2026-08-12.md — webui/GUI/tvOS/WebRTC + machine-role split

Status: mid-flight. Read fully before continuing; the code is the source of truth, this is a snapshot.

## 1. What the user wants (the driving requirements)

1. **Vibe/watch ALL surfaces from the webui chat** — TV (tvOS), watch (watchOS), car (CarPlay/Android Auto), AR/VR (visionOS/Android XR), mobile, web — each at its real pixel size, streaming to the browser over WebRTC.
2. **Project selection from the webui chat composer** (like mobile's task composer) AND from the desktop GUI app.
3. **Machine-role split** (AI runner = ubuntu-4gb-hel1-1 Linux box, Render = this Mac "Kvancs-MacBook-Air.local") must work end-to-end: tasks stream from the AI box, previews/WebRTC from the render box, both codebases synced via git commit+push.
4. **Deep-audit + Snowball** every failure: guard with tests, prove by breaking, land on every surface (web, GUI, tvOS, mobile).
5. **No deploys without explicit user approval.**

## 2. Deploy state (as of this snapshot)

- Cloudflare web: **live build `0bbf7616d`** at yaver.io (deployed + pushed). Earlier: Convex prod, TestFlight 514/515, tvOS, visionOS, CarPlay uploaded (previous sessions).
- Pushed to origin: `07e07f8be`, `b4a1ab26a`, `0bbf7616d` + earlier `b6b419c9c`, `da047f648`, `3afdbbd7f`, `c5d789e5a`.
- Uncommitted: web header simplification, GUI routing, tvOS TaskDetailView, mDNS WIP (see §6).

## 3. Committed fixes (this session, all verified tsc-clean)

| Commit | Fix |
|---|---|
| `07e07f8be` | **Runtime target probe failed** — `new URL(relative devBaseUrl)` threw before any request. Now `URLSearchParams` + fetch. Regression test added (5/5 pass). Deployed. |
| `b4a1ab26a` | **Chat composer Project dropdown** (Vibing tab, RuntimeLabView) + **per-platform Apple sim viewports** (`appleTargetViewport`: TV 3840×2160, iPad 1620×2160, Watch 396×484, Vision 1920×1080, iPhone 393×852) wired into `probeAppleSimTarget`. |
| `0bbf7616d` | **Render-machine project list under split** (`agentClient.listRenderProjects()` via devBaseUrl — fixes "no workspace manifest at /root/Workspace/yaver.io" when render ≠ connected box), **one-session-per-view** (close prior session on new target), viewer `aspectRatio` prefers agent viewport, `session.note` always rendered as a banner. |

## 4. CURRENT BLOCKERS (the next session's top priority)

### 4a. tvOS/watch/vision NEVER appear in the project list — THE blocker for "vibe all surfaces"
Root cause (verified): `tvos/`, `watch/`, `visionos/` are **NOT declared as apps in `yaver.workspace.yaml`** (manifest only lists backend/web/mobile/mobile-headless/desktop-*/relay/cli/sdk-*/e2e). The project catalog feeds from the manifest + git repos, and `tvos/` is neither (not its own repo). So the TV/Watch/Vision WebRTC targets are unreachable from the webui chat.
**FIX: add apps for `tvos` (stack: swift), `watch` (stack: swift), `visionos` (stack: swift), `wear` to `yaver.workspace.yaml`.** Then the picker offers them → Load Targets probes → tvOS WebRTC session streams at 3840×2160.
Note: the tvOS simulator ("Yaver TV" UDID `40B1695A-B993-4005-B826-CCE516702DC6`, tvOS 26.2) is BOOTED; remote-runtime API shape verified: `framework=swift` + `targetId=tvos-simulator` (a session was created earlier this session: `rr_1786567357919168000`).

### 4b. WebRTC browser-window session = white screen
Trace: `create session browser-window` → `waiting-for-dev-server` → white 5813-byte JPEG = about:blank. No dev server runs for the selected project on the render box; the agent deliberately won't auto-start one. The viewer now SHOWS the agent's note (fix landed) but **lacks a "Start dev server" route-to-fix button**. `agentClient.startDevServer` exists (agent-client.ts:5815). Wire a button into the note banner for browser-window sessions.

## 5. Other user-reported issues fixed or in flight

- **"Cant select project from webui chat"** — FIXED on the Vibing tab composer (`b4a1ab26a`); the **Chat tab (page.tsx)** has its own picker gated on `chatProjects.length > 0` fed by `refreshConnectedRunners` → `agentClient.listProjects()` (still CONNECTED-box only — does NOT use listRenderProjects; should be updated for split parity).
- **Chat header showed "Machines / AI: … · Render: …"** — user: "just runner model in here". Removed the Machines segment (uncommitted edit in `RuntimeLabView.tsx`); AI/Render pickers already live on the Load Targets row. tsc verified.
- **Submitted text invisible in console mode** — fixed (`b6b419c9c`): user prompts always render as `$` lines; purple working orb added.
- **Live stream folded while coding** — fixed (`3afdbbd7f`): fold gated on non-coding status; chat stream painted console-alike via shared `AnsiConsoleText`.

## 6. UNCOMMITTED work in the tree (do NOT lose)

- `web/components/dashboard/RuntimeLabView.tsx` — chat header Runner/Model-only (remove Machines segment). READY to commit.
- `desktop/app/src/renderer/index.html` + `desktop/app/src/main/main.js` + `desktop/app/src/main/preload.js` — GUI: AI/Render machine dropdowns + `route-agent` IPC (routes proxy to picked AI machine) + purple orb. Syntax-verified.
- `tvos/YaverTV/Views/TaskDetailView.swift` — `$ <prompt>` line + purple AngularGradient orb. 
- **Parallel mDNS work (NOT mine, mid-flight):** `desktop/agent/mdns_local.go`, `mdns_local_test.go` (untracked), `dns_mcp.go`, `ops_dns.go` (modified) — the `yaver.local` LAN hostname capability. Agent already reports hostname `yaver.local`. Needs owner decision: finish+commit or revert. This is what makes `yaver.local` resolve from other PCs on the LAN.

## 7. Machine-role split audit findings (deep audit, 2026-08-12)

- **Role routing:** `roleBase()` returns `/d/<id>` (same-origin relay proxy) or raw relay URL; `taskBaseUrl` = runner box, `devBaseUrl` = render box. `setMachineRoleRoutes` on the web; `route-agent` IPC added for the GUI.
- **Project-list source mismatch (fixed `0bbf7616d`):** picker offered connected/AI box projects while Load Targets probed render box → "no workspace manifest at /root/Workspace/yaver.io". Now `listRenderProjects()` when split active.
- **Sync contract:** agent does pre-task `git pull` (task_ensure_clone.go:135) classified permanent/transient/local (task_git_pull_failure.go). Runner box is currently BEHIND origin by 38 commits with dirty tree — its fix-task edits stale code. Needs commit/stash + pull. Git-worktree-per-task machinery exists (autorun.go:546-564).
- **IPs:** Mac LAN `192.168.111.11`, public `176.88.137.153`; agent API port 18080 (API only — dashboard UI is https://yaver.io). Agent hostname now `yaver.local`.

## 8. Remaining work queue (in order)

1. Add tvos/watch/visionos/wear apps to `yaver.workspace.yaml` → commit → deploy.
2. Finish "Start dev server" button in viewer note banner → commit → deploy.
3. Commit + deploy header simplification + GUI routing + tvOS TaskDetailView changes.
4. Chat tab (page.tsx) project picker: use `listRenderProjects()` for split parity.
5. Desktop GUI: project picker in chat (currently only prompts AI, no workDir on send).
6. tvOS WebRTC end-to-end walk (pick tvos → probe → session → stream at 3840×2160).
7. Sync the runner box (commit/stash dirty tree, pull origin).
8. mDNS yaver.local: owner decision + commit.
9. Headless verification of each with the browser tools (token: localStorage `yaver_auth_token`, staged at /tmp/yaver_token.txt).

## 9. Environment facts

- Local agent: `/Users/kivanccakmak/.yaver/bin/1.99.411/darwin-arm64/yaver serve --debug --work-dir=/Users/kivanccakmak/Workspace/yaver.io` on :18080. Auth token in `~/.yaver/config.json`.
- Test command: `npx tsc --noEmit` (web), `npx tsx web/lib/agent-client.test.ts` (5 tests), `node --check` (GUI JS), `go build ./...` + `go test -run "Doctor|Signing|Lease|PathSecret|DeployEnv"` (agent).
- Deploy: `./deploy/deploy.sh cloudflare` (canonical wrapper; owner-only perms enforced).
- Headless browser: `yaver_browser_*` tools; sessions `webui-lan-test` / `webui-probe-fix` may be stale.
