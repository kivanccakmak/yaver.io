# Remaining Tasks Handoff — Tasks-UI Deep-Audit Development (2026-08-09)

**Purpose:** continue the Yaver remaining-development work from the Tasks-UI deep audit.
Work top to bottom; commit each finished task with a conventional message and push.
This file is the source of truth for what is done, what remains, and what to deploy.

**Repo:** yaver.io @ `main` — HEAD is `4e6c09992` (cli 1.99.408: release).
**Model note:** this handoff was produced by a deepseek-v4-flash session; a fresh
codex/claude session can pick up exactly where it left off.

---

## Golden rules (AGENTS.md — they bind)

- `.md` files go stale. **Grep the code before trusting any file:line in this doc** — every
  reference was accurate at handoff time.
- Code wins over docs; when they disagree, fix the doc as part of the change.
- Never commit credentials; the repo is public on GitHub.
- Deploy is owner-only and needs explicit user confirmation — do NOT deploy without
  the user's go-ahead.
- Headless first, then closed loop. Probe the operation, never the inventory.
- **A parallel session may be active on this repo** (fork-path `allowLocalFallback`
  work, TestFlight build-number bumps, tmux-session ledger work). Re-check
  `git status` immediately before any commit and stage only your files.

---

## DONE + COMMITTED (do NOT redo — verify, then build on)

### Commit `0d10b6462` — "polish(tasks): show terminal liveness across web and mobile"
The **opencode task-output elegance pass** (both surfaces):

- **Web** (`web/app/dashboard/page.tsx`):
  - `TerminalStatusStrip` (~line 970) — one-line `● Live`(green, pulsing)/`Idle` · status ·
    `read-only` strip above the opencode xterm terminal.
  - `ChatAssistantMsg` (~line 1018) — memoized assistant bubble with "Show details ▾ /
    Hide details ▴" collapse for long outputs (>30 lines or >2500 chars, mirroring
    mobile's thresholds), **never collapses the still-growing live message**, and
    closes an unclosed ``` fence at the cut so truncated markdown can't swallow the
    transcript.
  - Chat|Terminal toggle → segmented pill with `💬`/`>_` glyphs, `aria-pressed`.
  - `rawLive` state + `markRawLive()` armed by the raw SSE lane on every LIVE frame
    (never the full-replace snapshot seed), 3s decay, cleared on `done` and task switch.
- **Mobile** (`mobile/app/(tabs)/tasks.tsx`, `mobile/src/components/XtermView.tsx`):
  - Same Live/Idle status strip above the terminal; `markRawLive` in `handleRawChunk`
    (`!full` frames only).
  - Segmented-pill toggle with icons + `accessibilityState`.
  - `XtermView` gained a `cursor` prop (threaded into the bridge script theme:
    cursor `#818cf8`, selection `#1f2937`); terminal palette unified with web
    (`#05070a`/`#d1d5db`).

### Commit `6adebfcd9` — "fix(tasks): bound runner waits across surfaces"
The **stuck-state wave 1** (all verified):

- **Web create chain bounded** (`web/lib/agent-client.ts`, `web/lib/task-placement.ts`):
  `createTask`/`continueTask`/`forkTask` use `fetchWithTimeout` (30s; `stopTask` 15s)
  with named AbortError messages; `placementFetch` bounded at 20s via AbortController.
  Kills the "…" send button forever.
- **CLI** (`desktop/agent/code_cmd.go`): `streamCodeTaskRef` SSE loop has a **60s idle
  deadline** wired through the request context (cancels the blocked read; named error
  with a route). `streamCodeGraph` has a **45-min staleness bound** with a named error;
  `streamGraphTaskDelta` now returns `(bool, error)` activity. **Released in cli
  1.99.408 (npm `yaver-cli@1.99.408` published — verified).**
- **watchOS** (`watch/YaverWatch/WatchStore.swift`): `.working` phase arms a **90s
  wall-clock timer**; any terminal reply cancels it; stale fires are no-ops. Wrist can
  no longer hang on "Working…" forever.
- **Wear OS** (`wear/app/.../`): `WearApp.kt` `LaunchedEffect` **90s Working-phase
  timeout**; `BoxLifecycle.kt` no longer fabricates READY for no-URL (phone-paired)
  wakes — new honest `WakeStatus.PendingPhone` + `WakeProgress` view, cleared in
  `WatchState.applyReply`; `MainActivity.kt` pending-transcript has a **10-min
  staleness guard** and is cleared on wake timeout.

### Verification status (at handoff)
- `go build ./...` (desktop/agent) — green.
- `npx tsc --noEmit` web — clean EXCEPT pre-existing `VibeCodingView.tsx:358`
  (`gitRemote` on `Project`) — NOT this session's work, do not fix here.
- `npx tsc --noEmit` mobile — clean EXCEPT pre-existing `TaskProofCard.tsx` (13 errs,
  dead file, another session's WIP), `DeviceContext.tsx:2937`, `.test.ts` URL-type
  errors. Do not fix.
- Wear `gradle :app:compileDebugKotlin` (incremental off) — green.
- **watchOS: NOT build-verified.** `WatchStore.swift` edited but no `xcodebuild` run.
  First action: build `watch/YaverWatch.xcodeproj` (scheme YaverWatch, generic
  platform=watchOS) to confirm.

---

## REMAINING TASKS (work top to bottom)

### Task 5 — Mobile: blocked cloud-workspace dispatches get a visible reason + route-to-fix
**The gap:** a cloud-workspace dispatch blocked on `runner_auth_required` /
`yaver_auth_required` / `billing_required` / `resize_required` / `resize_failed` /
`wake_failed` renders as a healthy pulsing "Queued" card with the reason buried in its
output array. `activationBlockReason` (`mobile/src/lib/taskPlacementCore.ts:76-96`) is
**never rendered anywhere**; the retry loop skips blocked rows forever
(`mobile/app/(tabs)/tasks.tsx:2454` — `if (pendingCloudDispatchNeedsUserAction(currentRow)) continue;`).

**Files:** `mobile/app/(tabs)/tasks.tsx`, `mobile/src/lib/pendingCloudDispatch.ts`,
`mobile/src/lib/taskPlacementCore.ts`, `mobile/src/lib/quic.ts` (Task type at :485).

**Design (mapped already, not implemented):**
1. Stamp the blocked info onto the placeholder: `pendingCloudTaskPlaceholder`
   (`pendingCloudDispatch.ts:321-348`) currently returns a `Task` with only `output`
   lines. Add optional fields to the mobile `Task` type (`quic.ts:485`,
   `placementId`/`placementLane` already exist at :546-547) — e.g.
   `pendingCloudBlockedAction?: string; pendingCloudBlockedReason?: string;` — and
   fill them from `normalized.blockedAction` / `normalized.blockedReason` (fall back to
   `activationBlockReason`-style defaults when the row has no reason string).
2. In `TaskCardInner` (the card renderer, ~`tasks.tsx:1190-1330`), when
   `item.id.startsWith("pending-cloud:")` (agent mints `pending-cloud:<uuid>`,
   `desktop/agent/task_placement_client.go:1247`) and `item.pendingCloudBlockedAction`
   is set, render an amber banner: `"Needs your action — <reason>"` plus a route-to-fix
   button per action:
   - `runner_auth_required` → **"Sign in to <runner>"** → `openRunnerAuthModal(runnerId,
     targetDeviceId)` (helper exists at `tasks.tsx:2289`, runner on the placeholder
     Task at `runnerId`).
   - `yaver_auth_required` / `billing_required` → **"Fix on Yaver web"** →
     `Linking.openURL("https://yaver.io")` (or billing URL) — honest, since the phone
     can't complete these.
   - `resize_required` / `resize_failed` / `wake_failed` → **"Retry"** → re-run
     `activateTaskPlacement({ placementId, pendingTaskId: localTaskId })`, then
     `mergePendingCloudPlacementStatus` + `updatePendingCloudDispatch` with
     `clearedBlockedAction: true` / status `queued` so the existing poller
     (`tasks.tsx:2430-2500`) takes over. Mirror the intent update the retry path already
     sends (`updateTaskDispatchIntent({ status: "dispatching", clearBlockedAction: ... })`).
3. Also surface the **24h TTL** (no silent expiry): show "expires in ~N h" on the
   blocked banner; when `dispatchStatus` flips `expired` → `stopped`, the card should
   say "Cloud Workspace dispatch window expired" (already in output via
   `pendingCloudDispatch.ts:92-93`) — render it as the banner when blocked info cleared.
4. Consider the task-list status dot: a blocked placeholder currently maps to
   `queued` (`pendingCloudDispatchTaskStatus`, `taskPlacementCore.ts:98-104`) — leave
   `queued` for the dot but let the banner carry the block (LESS IS MORE: one
   signal, not two).

**Verify:** tsc mobile clean; manually block a dispatch (workspace needing auth),
confirm the card shows the reason + button; tap Sign in → RunnerAuthModal opens.

### Task 6 — Web: blocked cloud-workspace dispatches rendered with reason + retry
**The gap:** on the dashboard, the blocked row's reason IS stored
(`web/lib/pending-cloud-dispatch.ts:63-77, 329-340`) but **never rendered**:
`selectTask` (the only consumer of the placeholder output) is **never called**
(`web/app/dashboard/page.tsx:2921-2941` has zero call sites), the poller skips blocked
rows (`page.tsx:2350`), and `pendingCloudDispatchTaskStatus` maps `blocked → "queued"`
(`pending-cloud-dispatch.ts:298-304`). A `runner_auth_required`/`billing_required`
block shows as a frozen healthy "queued" task; only a silent 24h TTL escapes it.

**Files:** `web/app/dashboard/page.tsx` (chat tab), `web/lib/pending-cloud-dispatch.ts`,
`web/components/dashboard/VibeCodingView.tsx` (mirror), `web/lib/agent-client.ts`.

**Design:**
1. In the chat tab, render pending-cloud placeholder rows (currently they land in
   `tasks[]` but nothing surfaces them): when the active/visible pending dispatch is
   `blocked`, show an inline card: `"Cloud Workspace is waiting on you — <reason>"` +
   action (`runner_auth_required` → the existing chat runner-auth modal;
   `yaver_auth_required`/`billing_required` → link to yaver.io billing;
   resize/wake → "Retry" that re-activates the placement like the mobile Task 5).
2. Give the blocked row a distinct look vs the amber pulsing "queued" (it currently
   renders as queued: `page.tsx:4241-4243`).
3. Surface the TTL ("expires ~N h") instead of the silent flip to `stopped`
   (`normalizePendingRow`, `pending-cloud-dispatch.ts:79-94`).

### Task 7 — Watch/car phone relay: stop flattening `cloud_workspace_required`
**The gap:** the phone-side relay calls `sendTask`; the 409 `CloudWorkspaceRequiredError`
is caught by `dispatchAndSummarize` and flattened to **"I couldn't reach your box."**
(`mobile/src/lib/carVoiceCoding.ts:242-244`). The prompt WAS queued (agent persisted a
pending-cloud dispatch it will retry) — the wrist/car is told it failed. The agent's
direct `/watch/turn` endpoint does it right (`desktop/agent/watch_http.go:150-200` →
`handoff`/`cloud-workspace` + "Your Cloud Workspace is getting ready. Continue on your
phone.").

**Fix:** in `carVoiceCoding.ts` `dispatchAndSummarize`'s catch, and the watch/car reply
paths (`mobile/src/lib/watchBridge.ts` `dispatch`, `mobile/src/lib/carReplyDispatch.ts`),
detect `CloudWorkspaceRequiredError` (or `err.action === "cloud_workspace_required"` /
presence of `pendingTaskId`) and speak the honest line instead:
`"Your Cloud Workspace is waking — it'll run there. I'll let you know when it's done."`
Return a `handoff`-shaped reply (`WatchProtocol.Reply.Handoff`) so the wrist shows the
text and returns to idle (handoff is already handled: `WatchStore.swift` / `WatchState.kt`).

### Task 8 — Mobile wizard: single-device auto-pick must respect online state
**The gap:** `mobile/src/components/TaskTargetWizard.tsx:516-529` auto-picks the single
eligible device **without checking `online`**, while `handlePickDevice` at :310 does
check. One offline box → auto-picked → "Couldn't switch" error pane.

**Fix:** add `&& device.online` (or the same `offlineNeedsAuth` rule the disabled rows
use at :570/:601-602) to the single-device auto-pick condition.

### Task 9 — Server placement: `candidateOwnedDevice` honors primary→secondary
**The gap:** `backend/convex/taskPlacement.ts:357-378` — when no `targetDeviceId` is
given, the owned-machine lane is `pool.find(...)` = **first online device in DB order**.
It never consults `userSettings.primaryDeviceId` / `secondaryDeviceId`, so the
"preferred machine" every client auto-connects to can be overridden by placement
(web auto-connect ladder lives in `page.tsx:2459-2527`; mobile in
`DeviceContext.tsx:2407-2408`; the MCP `primary_*` tools resolve the primary at
`desktop/agent/mcp_primary_tools.go`).

**Fix:** in `candidateOwnedDevice`, fetch `userSettings` (see `backend/convex/userSettings.ts`
/ `devices.ts:786-790` for the shape) and order the candidate pool:
explicit `targetDeviceId` → `primaryDeviceId` (if online+eligible) →
`secondaryDeviceId` → first online. Keep the runner/needsBuild filters. Add a test in
`backend/convex/taskPlacement.test.mts`.

### Task 10 — MCP `create_task`: accept `device_id` (or a primary variant)
**The gap:** `desktop/agent/httpserver.go:6780-6901` — `create_task` args have **no
device field**; placement is pinned `TargetDeviceID: s.deviceID` (:6820) = the machine
running the MCP server. `primary_*` tools exist (`mcp_primary_tools.go`,
`resolvePrimaryDeviceIDForMCP`) but there's **no primary create_task**. CLI can
`--attach <device>`; MCP cannot — three different device-routing shapes.

**Fix (pick one, both defensible):**
1. Add optional `device_id` to `create_task` args; when set, resolve a reachable address
   for it (reuse the `/devices` + `firstReachable` machinery) and POST to that agent
   (like the CLI's `createHTTPTaskWithCloudHandoff` path). When empty, keep local
   (backward compatible).
2. Add `create_task_on_primary` (or `primary_create_task`) that reuses
   `resolvePrimaryDeviceIDForMCP` and routes the same body to that device.
Update `mcp_tools.go:7-52` schema doc + the tool description.

### Task 11 — Web chat composer: per-task MCP server selection
**The gap:** the chat composer's `taskParams` (`page.tsx:2768-2775`) carries **no
`mcpServers`** → `buildCreateTaskBody` sends `[]` (`agent-client.ts:1878`). VibeCodingView
has per-task MCP toggle chips (`VibeCodingView.tsx:2427-2456`); mobile has them
(`tasks.tsx:5933-5936, 6179-6210`). Same user, different capability per tab.

**Fix:** add the same "N MCP" scope chip + a Task-config section (list enabled servers,
multi-select) to the chat composer, plumb `selectedMcpServers` into `taskParams.mcpServers`
and the fork path (Vibe already does this at `VibeCodingView.tsx:1402,1474,1620,1694,2066`
and `agent-client.ts:2461`). Reuse the existing `listMcpServers` (`agent-client.ts:2516`).

### Task 12 — visionOS: surface identity mismatch
**The gap:** `tvos/YaverTV/SessionClient.swift:188-195` hardcodes
`surface.id = "tvos"` in the runtime-turn payload while the HTTP header is
`X-Yaver-Surface: vision` (`Backend.swift:22-26`, Info.plist `YaverNativeSurface=vision`).
The box sees contradictory identities for the same turn.

**Fix:** make the surface id a parameter of `runtimeTurn` and pass `"vision"` from the
visionOS call site (`visionos/YaverVision/Views/VisionSessionView.swift:247-264`), keeping
`"tvos"` for tvOS callers. Grep all `runtimeTurn`/`sendText` call sites in `tvos/` +
`visionos/`.

### Task 13 — Android Auto: notification-id collision
**The gap:** `mobile/native-androidauto/ios/.../YaverCarMessagingModule.kt:183` uses
`conversationId.hashCode()` as the notification id — two conversations on the same box
overwrite each other's notifications.

**Fix:** include the message identity: `(conversationId + "/" + messageId).hashCode()`
or a monotonic counter keyed per conversation, so multiple agent messages coexist in
the car's MessagingStyle stack.

### Task 14 — Phantom `yaver task create`
**The gap:** `desktop/agent/switch_steps.go:399` tells users to run
`yaver task create --from-file <out>` — that command does not exist (main.go dispatch
`main.go:466-824` has no `task` case).

**Fix (cheap):** change the copy to a real verb: `yaver code --from-file <out>`
(check `code_cmd.go` for whether `--from-file` exists; if not, use
`yaver code "$(cat <out>)"` or add a `--from-file` flag to `yaver code`). Then fix the
doc reference in the emitted string.

### Task 15 — Stale copies
- `mobile/native-carplay/ios/YaverCarPlaySceneDelegate.swift:39-42` is a stale copy of the
  shipped `mobile/ios/Yaver/YaverCarPlaySceneDelegate.swift` (which has the
  `CPVoiceControlTemplate` + deep-link at :84-88). Sync the copy or add a comment that the
  shipped file is authoritative.
- `mobile/native-androidauto/.../YaverCarMessagingModule.kt:3-7` header says "NOT yet
  wired" but it IS wired via `mobile/plugins/withAndroidAutoMessaging.js` + `app.json:181`.
  Fix the header comment.

---

## VERIFICATION CHECKLIST (before any deploy)

1. `go build ./...` + `go vet ./...` in `desktop/agent`.
2. `npx tsc --noEmit` in `web/` — only the pre-existing `VibeCodingView.tsx:358` error allowed.
3. `npx tsc --noEmit` in `mobile/` — only the pre-existing TaskProofCard/DeviceContext/test errors allowed.
4. **watchOS build** (outstanding from this session): `xcodebuild -project watch/YaverWatch.xcodeproj -scheme YaverWatch -destination 'generic/platform=watchOS' build` — must pass.
5. Wear: `gradle :app:compileDebugKotlin -Pkotlin.incremental=false` in `wear/`.
6. Convex: `backend/convex` — `npm run typecheck` (or the repo's convex check) after Task 9.
7. Headless probes (AGENTS.md): raw lane via `curl <agent>/tasks/<id>/output?rawSince=0`;
   blocked-dispatch UI by blocking a workspace dispatch and checking the card.

## DEPLOYMENT (owner-only — requires the user's explicit go-ahead)

Per `NEXT_DEV_TASKS.md` + this session's state:

1. `./deploy/deploy.sh npm` — agent CLI. **Already released:** `yaver-cli@1.99.408` on npm
   includes the Task-2 CLI fixes (verified). Only needed again for Task 10/14 agent changes.
2. `./deploy/deploy.sh web` (cloudflare) — ships Tasks 5/6/11 (dashboard). **The deployed
   worker is STALE**: `raw_replay`/`rawOutput`/`rawSince` = 0 matches in every deployed JS
   chunk (verified by probing `yaver.io/_next/static/chunks/*.js`) — the opencode terminal
   view + all web work are not live until this runs.
3. `./deploy/deploy.sh ios` (TestFlight) — ships mobile Tasks 3/5/7/8 + the terminal
   elegance work. The TestFlight script bumps the build number (Info.plist already shows
   506→507 staged). Do NOT bump manually.
4. `./deploy/deploy.sh android` — optional; ships Wear (Tasks 4) + Android Auto (Task 13)
   after those land.
5. Convex backend deploy — required after Task 9 (placement ladder).

## NOT this session's work — do not claim/commit

- `mobile/ios/Yaver/Info.plist` CFBundleVersion 506→507 (staged TestFlight bump).
- Fork-path work (`desktop/agent/task_fork.go` + `_test.go`, `tasks.go` fork hunks,
  `VibeCodingView.tsx` fork sends `allowLocalFallback: true`, `agent-client.ts` forkTask
  hunks, `docs/architecture/TASK_MCP_PROJECT_SELECTION.md` untracked).
- tmux-session ledger work (`backend/convex/tmuxSessions.ts` untracked + schema.ts change).
- Pre-existing type errors listed above belong to their own sessions.
