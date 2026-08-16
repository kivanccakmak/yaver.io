> **STATUS 2026-07-27: ALL ITEMS COMPLETE.** Every task below was implemented
> test-driven, committed, and deployed in the 2026-07-27 session: mobile P0
> wave (1a-1g), agent/backend 2a-2d, iOS deep links (§3, ships in TestFlight
> 478/479), web queue (§4), releases (§5 — cli 1.99.374 on npm + the linux
> box, web + Convex deployed, Play internal uploaded by CI, TestFlight 478 &
> 479). Also: relay bandwidth caps became account-keyed (owner-dev unmetered),
> and remained.md P0-UI/P1 landed (RunnerAuthModal terminal states + liveness,
> compile-failure cards). Kept for reference only.

# Remaining Tasks — Browser-Lane / Cross-Surface Session Handoff (2026-07-26)

Written at the end of the 2026-07-26 browser-lane marathon for a FRESH session.
Everything here follows the house rules: fix the PRODUCT, probe the operation
not the inventory, name every failure, ship to every surface, prove guards by
breaking them. No IPs, tokens, or passwords in this file — the repo is public.
Machine references: **the linux box** = `ubuntu-4gb-hel1-1` (alias `linux-3`,
reachable via `yaver ssh linux-3` / Tailscale), **the public relay** = the host
serving `public.yaver.io` (SSH access exists from this Mac; unit
`yaver-relay`, binary `/opt/yaver-relay/yaver-relay`, backup of the previous
build sits next to it as `yaver-relay.bak-0122`).

---

## 0. What already shipped today (do NOT redo)

| Piece | State |
|---|---|
| Agent fix: direct expo-web lane reported "browser preview exited" while serving | `4201ae625`, released in cli **1.99.372** |
| Agent fix: relay-auth rewrite (`applyPreviewRelayAuth`) was dead code, now wired into `rewriteDevIndexBaseHref` | `89599d5d3`, in 1.99.372 |
| Doctor browser-lane probe re-synced with `previewReadyScript.ts` (parity test now pins BOTH halves) | in 1.99.372 |
| Relay deployed from HEAD → webview cookie minting live (subresources authenticate through `/d/<id>/…`) | verified: page 200 + Set-Cookie + 17.6 MB entry.bundle in ~1 s |
| Agent fix: meta install plans (flutter, android-sdk, webrtc-stack…) reachable from `POST /install/<tool>` and `yaver install <tool>` | `d8a3134f1` + bump, released in cli **1.99.373** |
| Convex backend deploy, Cloudflare web deploy (Release Web workflow), npm 1.99.372 + 1.99.373 published | done |
| TestFlight **build 477** uploaded (Apple processing) | done — carries the mobile main as of ~15:00 UTC |
| The linux box: agent self-converged to official 1.99.373 via auto-update; Flutter SDK installed at `/opt/flutter` via the fixed endpoint; `/usr/local/bin/flutter` symlink added by hand | done |
| opencode on this MacBook switched `zai-coding-plan/glm-4.7` → `glm-5.2` (glm-4.7 silently no-ops) | done (machine config) |
| E2E evidence: iOS-sim app rendered sfmg / talos/mobile / yaver.io/mobile via browser lane from the linux box (PIXELS + interactive + reload); `e2e/todo-iframe-loop.mjs` vs the box: **4 PIXELS / 1 NAMED / 0 SILENT** | proven |

**Committed but NOT yet released** (needs cli 1.99.374): commit *"three false
states named…"* — PreStart clears stale `b.err`; exited-guard requires
`!Building`; empty runner reply → FAILED with named remedy
(`tasks_empty_reply.go`); `runtimeBinDirs` includes `flutterRoot()/bin`.
**First action of the fresh session: check `git log`/`git status`, then cut
1.99.374** (recipe in §9).

---

## 1. Mobile fix wave — LANDED as `dc74047f9` (review, then ship TestFlight 478)

All six items below are implemented, unit-tested (devStatusPolling 4/4,
previewPhase 9/9, tsc clean) and committed as `dc74047f9` — *"the browser-lane
P0 wave"* (10 files, +503/−35). Remaining for a fresh session: (a) review
`git show dc74047f9`, (b) live-verify on the sim (tap Open in Yaver from task
detail; bounce the relay and watch the poll recover), (c) ship in TestFlight
478 together with the deep-link fix (§3). Known deliberate gaps: the stale
`isConnected` 30-45 s heartbeat window in `connectedDeviceIds()` was NOT
tightened, and audit item 6 (target parity, §1g) is untouched. The seams below
are kept for review context:

### 1a. [P0] "Open in Yaver" dead tap — modal-behind-modal
- `mobile/app/(tabs)/tasks.tsx:5941` renders `<DevPreview/>` INSIDE the
  task-detail `<Modal>` (opens :5641). DevPreview's browser lane only does
  `setShowPreview(true)` → its own `<Modal>` (`DevPreview.tsx:740`). iOS cannot
  present a second Modal over one already on screen — the repo documents this
  exact trap at `tasks.tsx:3304-3311` (`pendingAfterDismissRef` handoff).
  Result: tap "succeeds", presents nothing, zero feedback.
- Fix: presentation-aware DevPreview (inline full-screen View when hosted in a
  modal, or reuse the pendingAfterDismiss handoff). Add: NO code path in
  `handleOpen`/`handleRunInYaver` may end without visible UI change or Alert.
- Secondary (same component): success path never `setNativeLoading(false)`
  (`DevPreview.tsx:443-554`, only catch does); status poll flash-closes the
  preview on a SINGLE failed `getDevServerStatus()` (`DevPreview.tsx:206-226` —
  require 2-3 consecutive failures, never close a WebView that has rendered).
- Note: `mustUseNativePreview` is NOT the bug in this tree — `devLane.ts:53-66`
  correctly yields browser lane for `devMode==="web"`. Pin it with a test.

### 1b. [P0] Connection single-source-of-truth (explains every split-brain seen)
- Header green = pooled `connectedDeviceIds` (`RemoteBoxBanner.tsx:79`);
  taps go through the FOCUS proxy (`quic.ts:10670-10697`,
  `connectionManager.ts:87-93`); `connectionStatus` state is a focus-bound
  listener (`DeviceContext.tsx:2058-2107`) that goes stale when focus shifts.
- The divergence seam: `DeviceContext.tsx:2069-2085` — on `attempt >= max` it
  calls `connectionManager.disconnect(activeDevice.id)` which clears focus but
  leaves `activeDevice`; from then on every `quicClient.*` hits the fallback
  client → "QuicClient is not connected. Call connect() first." while the
  header shows Connected. (Also contradicts `quic.ts:7177-7184` which retries
  previously-reachable boxes forever.)
- Fix: re-assert `setFocused(activeDevice.id)` on ensureConnected success and
  whenever `focusedDeviceId() !== activeDevice.id`; delete the give-up
  teardown for previously-connected devices; make `assertConnected`
  (`quic.ts:6182-6186`) self-describing.
- Same family, WEB surface: prod-adjacent dashboard showed "Couldn't load
  projects — AgentClient is not connected. Call connect() first." while the
  device card said connected (triggered by an agent restart; user later said
  works in prod — dev-web path). Fix the web AgentClient the same way: on
  not-connected → connect() + one retry; card state from transport truth.

### 1c. [P0] Stale "Waiting for the dev server to report its address…"
- String renders at `apps.tsx:3048-3050` when `bundleUrl` empty ⇔ `devStatus`
  null. The `/dev/status` poll (`apps.tsx:787-842`) is gated on
  `connectionStatus === "connected"` — the stale focus-bound signal — so after
  a relay bounce it never restarts even though the box serves fine.
- Fix: poll via `connectionManager.clientFor(activeDevice.id)`, gate on
  `connectedDeviceIds.includes(activeDevice.id)`; waiting overlay gets a 10 s
  reason + Retry (calls `selectDevice(activeDevice)`); subscribe connection
  state per pooled client (`connectionManager.ts:136-144`), not via the proxy.

### 1d. [P1] Reconnect ladder never refreshes topology
- `quic.ts:7153-7230` backoff reuses the relay-server snapshot; DeviceContext
  refresh + `repairRelay` gate on `connectionStatus === "error"` which
  ping-pongs; "device not connected to relay" (relay `server.go:1857-1864`)
  matches no self-heal pattern (`quic.ts:7212-7217`). App recovers only on
  relaunch (boot re-pulls everything).
- Fix: `topologyRefreshHook` every ~3 failed attempts (same seam as
  `setRelayRepairHook`, `quic.ts:7237-7241`) re-pulling relay list + device
  row; classify "device not connected to relay" as box-presence with honest
  banner text ("your box lost its relay session — it usually re-registers
  within a minute").

### 1e. [P1] Flutter phase narration
- Title at `apps.tsx:3261-3263` is static "Starting … dev server…" regardless
  of probe reason; probe truth (`previewReadyScript.ts` reasons:
  `flutter_booting`, `empty_mount`, …) reaches UI only as a small diagnostic
  line. Same in DevPreview (`DevPreview.tsx:980-999`).
- Fix: shared pure `previewPhaseTitle(devStatus, probe)` in `mobile/src/lib/`
  used by BOTH implementations + timeout panel that names the
  `flutter_booting` cause (failed asset/CanvasKit fetch through the proxy —
  check log tail for 404s). Unit-test per reason.

### 1f. [P1] webPort/bundleUrl couplings + DevPreview empty-url gap
- `apps.tsx:1986` and `DevPreview.tsx:618` force `/dev-web/` whenever
  `webPort` is set, overriding `bundleUrl`. Works today only because agent
  `WebPort()` and the `/dev-web/` route agree. Prefer `status.bundleUrl` when
  non-empty on current agents; keep the override only for `< 1.99.355`.
- `DevPreview.tsx:619` still defaults `|| "/dev/"` and mounts the WebView
  unconditionally (`:893-896`) — port apps.tsx's empty-url guard
  (`apps.tsx:3033-3036`).

### 1g. [P1] Target-discovery parity (mobile vs web "Load Targets")
- Mobile consumes `project_preview_options` in exactly one place
  (`apps.tsx:1084-1093` → `applyPreviewCapabilities`); full RemoteRuntime
  target list (redroid / android-device / browser-window with reasons) only
  two hops deep in `remote-runtime.tsx` with no grouping/collapse like web's
  `targetGroup()` (`web/components/dashboard/ProjectDetailView.tsx:258-275`).
- `apps.tsx:1060-1075` hardcodes the Hermes/Browser/WebRTC trio;
  `applyPreviewCapabilities` (`mobileProjectActions.ts:63-92`) can strip and
  annotate but never ADD an agent-offered option → agent's `wire-push` option
  is silently dropped. Invert: compose from `caps.options` (id → handler
  registry), fall back to the trio only when the agent can't answer; unknown
  ids render disabled with the agent's label+reason. Test with a caps payload
  containing `wire-push` + an unknown id (fails today).
- Monorepo sub-apps: mobile has NO `/workspace/apps` client method
  (web uses it, `web/lib/agent-client.ts:525`); add `getWorkspaceApps()` to
  `quic.ts` and a "pick a sub-app" step (mobile · expo / web · next) when
  tapping a monorepo project.

---

## 2. Agent/backend items with mapped seams

### 2a. Device-row shadowing (two devices, one hostname → picker flip-flop)
Background: the linux box runs a second `yaver serve` — the **circuit-sim
cell** (`/usr/local/bin/yaver-sim`, port 18090, relay-only, running since
June, session EXPIRED — **I left its systemd service STOPPED**; restart only
after fixing its auth or this bug). Its device row shares hostname with the
real agent's row.
- Server: `backend/convex/devices.ts:328-334` alias key
  `${platform}:${normalizeDeviceName(name)}`; `mergeListedDevices:386-392`
  last-heartbeat-wins → deviceId/name flip every heartbeat;
  `collapseListedDevices:455-478` merges even on `strongConflict` when
  `pickActiveListedDevice` returns null (both healthy).
- Fix at `devices.ts:470-476`: on strongConflict with null winner keep BOTH
  rows (key by `hardwareId ?? deviceId`); mirror the client collapse in
  `mobile/src/context/DeviceContext.tsx:775-784`. Then: instance label/role on
  rows so a service cell renders distinctly (or is excluded from the personal
  picker). Deploy Convex after.

### 2b. Orphaned dev-server children + boot-time toolchain cache
- Expo/next children survive agent restarts, squat ports → `portSubstituted`
  on every restart (seen 3×). Reap on shutdown (process group kill) AND on
  boot (scan for listeners the agent's own resource table claims).
- Flutter "executable not found" persisted AFTER the SDK was installed and on
  PATH until the agent was RESTARTED → something caches toolchain presence at
  boot. Find it (suspect: startup toolchain inventory / mobile-scan) and make
  presence be probed at `/dev/start` time. The `runtimeBinDirs` flutter fix
  (committed) removes the common case; the cache is still a false-negative
  machine.
- Relay + agent WS-fallback tunnels cap proxied responses at 10 MB and only
  exempt `/dev/` — `/dev-web/` misses the exemption (`relay/tunnel.go:325-329`,
  `desktop/agent/main.go:11759-11763`, incl. `stripFrameBlockingHeaders` and
  `isLongDevRequest`). QUIC path streams so it works today; fix the fallbacks
  to match (`/dev-web/`, and prefer prefix helper shared by all three).

### 2c. Empty-reply guard follow-ups (task "Helo" incident)
- Guard is committed (clean exit + zero output → FAILED + named remedy).
  Follow-ups: run a CONTROL task through opencode/glm-5.2 on this MacBook and
  the linux box to verify replies flow; consider surfacing the model NAME in
  the failure card (task metadata has it); the phone's task detail for that
  incident showed model glm-4.7 — confirm the label reflects the actually
  dispatched model post-`6c3247d31`.

### 2d. Smaller named bugs (each one-file)
- `yaver ssh` prints "release lookup failed (403) from kivanccakmak/yaver.io" —
  stale repo path in the release resolver; point at `yaver-io/yaver.io`
  (grep `kivanccakmak/yaver.io` in desktop/agent).
- Talos cloud-agent container on the linux box writes its auth token through a
  shell heredoc → visible in `ps` output (process-listing credential leak).
  Fix the launcher to write the config via stdin/file perms, not argv/heredoc
  in the command line.
- Web runtime console prints "1575% streaming" — bogus percentage source.
- Bento E2E workflow is red on every push since before today — triage
  separately; it predates all of today's commits.
- `TestBuildFeedbackInstallPlan` fails on main (pre-existing) — fix or quarantine.
- Mobile Metro dev toast overlaps the tab bar and eats its taps (dev-only).

---

## 3. iOS deep links are DEAD app-wide (CarPlay scene manifest)

Verified: `xcrun simctl openurl booted "yaver://car-voice-coding"` → no
navigation, no JS log, on Debug build 474. `Info.plist` has
`UIApplicationSceneManifest` declaring ONLY the CarPlay scene
(`YaverCarPlaySceneDelegate`); with scenes active, URL opens go to scene
delegates and `AppDelegate.application(_:open:options:)` (which forwards to
`RCTLinkingManager` correctly — `AppDelegate.swift:1056-1067`) never fires.
Breaks `?selectDevice=` links, the car shortcut, all yaver:// integrations.
Fix: declare `UIWindowSceneSessionRoleApplication` with a SceneDelegate
forwarding `openURLContexts` + `continueUserActivity` to RCTLinkingManager
(force-tracked overlay under `mobile/ios/Yaver/` + prebuild config so
`expo prebuild --clean` survives it). Prove with the simctl openurl test.
Ship in the NEXT TestFlight (478) — 477 does not have it.

## 4. Web dashboard work queue

- **Runner switch + remote OAuth from right pane**: partially EXISTS on the
  localhost build (runner + model dropdowns + "Save for machine" were seen
  working; the box's model flipped to glm-5.2 through it). Another session
  pushed *"Fix runtime target and runner OAuth flows"* to main late in the
  day — REBASE and verify what's left: the full RunnerAuthModal parity
  (structured phases per `remained.md` P0 contract) and prod deploy.
- **Runtime console → stream `/dev/events` SSE** during lane opens (it showed
  agent dev logs on localhost build for the yaver/mobile lane — verify prod +
  ensure error lines (412 missing-toolchain with remedy) render, instead of
  the observed generic "Still no browser preview after 182s".
- **Monorepo target discovery** offering `yaver / mobile · expo` worked on the
  localhost build — verify prod parity after next web deploy.
- **Project detail redesign** (user request): stack → target → render wizard;
  PLATFORMS chips are a raw enum dump (`tv, vision, none, unsupported`),
  PRIMARY "none · unsupported", ROLE "unknown · backend not detected" — load
  the `frontend-design` skill and make it elegant. Seams:
  `ProjectDetailView.tsx` (+ `/workspace/apps`, remote-runtime capabilities).

## 5. Deploy state / what a fresh session must finish

- **cli 1.99.374**: carries the committed-but-unreleased agent fixes (§0 tail).
  Recipe: bump `cli/package.json` + `versions.json` → commit
  `chore(release): cli 1.99.374` → push → `gh workflow run release-cli.yml`
  (builds+signs+creates GH release; publish-npm is skipped by design) → after
  CI green: `cd cli && npm publish` from a Mac → the linux box self-updates
  (auto-update is ON there).
- **Android/Play**: local build died from DISK (both Macs <10 GB). Dispatched
  `gh workflow run release-mobile.yml` (android job) — CHECK ITS RESULT; if
  the workflow's android path doesn't auto-upload, run
  `PLAY_STORE_KEY_FILE=keys/google-play-service-account.json python3
  scripts/upload-playstore.py` per CLAUDE.md, or build on a machine with
  ≥25 GB free. versionCode reached 286 locally before the kill.
- **tvOS / watchOS / wearOS**: per repo reality (memory:
  `project_native_surface_deploy_traps`) watchOS has NO upload channel and the
  tvos/watch xcodeproj are gitignored→stale. Do not fake these; decide the
  channel first.
- **TestFlight 478** after the deep-link fix + mobile fix wave land.
- Disk hygiene for this MacBook: biggest reclaim levers found today:
  `~/Library/Caches/go-build` (was 8.9 G), `~/.gradle` (8.6 G after one
  android build), `/tmp/Yaver.xcarchive` + `/tmp/Talos*`, npm cache.
  `mobile-cache-cleanup.sh preflight` is a stub — read `df` yourself.

## 6. The linux box — current state (leave-it-clean checklist)

- Agent: official 1.99.373, auto-update ON, serving normally.
- `yaver-sim` (circuit cell) systemd service: **STOPPED by me** (expired auth +
  hostname collision caused picker flip-flop). Restart only with 2a fixed or
  its auth repaired.
- Flutter: `/opt/flutter` + `/usr/local/bin/flutter` symlink + warmed
  (Dart 3.12.2). **Last e-mobile lane verdict**: NAMED failure —
  "flutter exited before becoming ready: exit status 1 … Woah! You appear to
  be trying to run flutter as root" — while the SAME command works from an
  SSH shell as root. Root cause direction: daemon-spawned flutter lacks the
  login-shell env (HOME/PUB_CACHE etc. under systemd) and/or needs the
  root-acknowledgement flag; fix belongs in the agent's toolchain env
  augmentation (same family as the runtimeBinDirs PATH fix), not in the box.
  After that, expect either serving or the known `image_editor_plus`/
  `FaIconData` compile error (which the task surface must show as a compact
  named failure, not raw purple logs — remained.md P1).
- Old agent binaries pruned (kept 1.99.371+); npm/apt caches cleaned.
- `todo-rn` fixture cloned at `~/Workspace/todo-rn` with deps (for the iframe
  loop).

## 7. Verification commands (no secrets inline — tokens live in the box's
`~/.yaver/config.json`, creds for e2e sign-in in the user's password store;
NEVER paste values into files or logs)

```bash
# lane truth on the box (run ON the box):
TOKEN=$(python3 -c 'import json;print(json.load(open("/root/.yaver/config.json"))["auth_token"])')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"framework":"expo","workDir":"/root/Workspace/sfmg","platform":"web","caller":"web-ui"}' \
  localhost:18080/dev/start
curl -s -H "Authorization: Bearer $TOKEN" localhost:18080/dev/status | jq '{running,serving,webPort,bundleUrl,error}'

# closed loop from the Mac (Playwright, 4 PIXELS / 1 NAMED / 0 SILENT baseline):
cd e2e && AGENT_URL=http://<box-tailscale-ip>:18080 YAVER_AGENT_TOKEN=<box token> \
  node todo-iframe-loop.mjs

# iOS sim driving recipes (no idb): Simulator → Window → Point Accurate;
# screen origin = window pos + (27,63), 1pt=1px;
# osascript System Events 'tell process "Simulator" to click at {x,y}';
# cliclick dd/m/du for drag; Hermes CDP console via localhost:8081/json.
```

## 8. Standing constraints (repeat of the ones that bit today)

- `git commit -- <paths>` only; several sessions share this tree (other
  sessions' WIP was present in `console_terminal.go`,
  `devserver_root_ws_test.go`, `DeviceContext.tsx`, stashes).
- Never edit `mobile/` while a local mobile build runs; agent-side edits are
  fine after the gradle/xcode inputs are read.
- macOS hot-swap of agent binaries: never (codesign); Linux hot-swap: fine but
  the AUTO-UPDATER will revert it — disable `auto_update` in the box config
  for the test window and restore after (or just cut a release: CI takes
  ~4 minutes end-to-end).
- `pkill -f "expo start"` from an SSH one-liner kills your own session
  (pattern matches the ssh argv) — use `"expo [s]tart"`.
- Credentials: env-only, never in files/logs/commits; the app itself redacts
  `token=` in its preview logs — keep it that way.

## Mobile preview feedback occlusion (deferred — needs on-device test) 2026-07-28
The full-screen WebView preview is `<Modal presentationStyle="fullScreen">`
(`mobile/app/(tabs)/apps.tsx:3174`). iOS cannot present anything over an
already-presented full-screen modal, so BOTH of these are occluded:
- **Shake → feedback**: browser-lane shake injects `yaver-feedback:launch`
  into the WebView (`apps.tsx:994-1003`) — dead-letters unless the guest embeds
  yaver-feedback-web — AND `triggerFeedbackLaunch` opens the ROOT
  `FeedbackOverlay` (`_layout.tsx:168`, an `Animated.View` — not a Modal),
  which renders BEHIND the preview modal. Result: shake does nothing.
- **"12 issues" panel** (`apps.tsx:3462`): the log panel + "Fix in Yaver"
  toggles fine but any overlay it spawns is behind the same modal; and the
  count is WebView-only (no Hermes-lane feed).
FIX (test on device, don't ship blind — burns TestFlight slots): render a
feedback entry/overlay INSIDE the preview Modal's `<View>` so it presents
over the WebView, rather than relying on the root FeedbackOverlay. Reconcile
with DevPreview.tsx which lacks the mic + issues FAB entirely (apps.tsx drift).
The mic fix (1.18.165) already dismisses the modal first — that pattern loses
the app screenshot for shake, so shake needs the in-modal approach instead.
