# Runner/Render Split — handoff (2026-07-27)

Continuation state for the optional machine-role slicing. Architecture +
audit: `docs/architecture/RUNNER_RENDER_SPLIT.md` (read it first — every
claim there carries file:line). This file is the DELTA: what is landed and
verified vs what a fresh session builds next, in order.

## DONE (landed, deployed, verified)

- **Convex config (prod)** — `machineRolesByProject` in `userSettings`:
  `{projectName?, runnerDeviceId, renderDeviceId?, workspace:
  "runner-clone"|"render-ssh", autoPush: "never"|"ask"|"always", updatedAt}`.
  Row without `projectName` = account-wide favorite; per-project rows
  override; `runnerDeviceId: null` clears a scope. Merge:
  `mergeMachineRoles` (`backend/convex/userSettings.ts`); write path via
  `POST /settings { machineRolesForProject }` (`backend/convex/http.ts`),
  read via `GET /settings` → `settings.machineRolesByProject`. Verified live
  against prod: write → read → clear.
- **Security** — `assertMachineRolesOwned` runs in BOTH mutations (`set`
  passes `args.userId`, `setByToken` the session user): every referenced
  deviceId must be the caller's. Do-time enforcement is per-box (bearer +
  guest scopes, fail-closed) — a forged row grants nothing. Guests never
  read the owner's settings doc; render-only sharing = existing guest
  scopes, no new surface.
- **Web Settings UI** — `web/components/dashboard/MachineRolesCard.tsx`,
  mounted in the settings tab (`web/app/dashboard/page.tsx`, above
  SettingsView, below PlanUsageCard). Favorite-config editor: runner picker,
  renderer picker (same machine allowed = default posture; "single-box
  (default)" vs "split active" chips), workspace mode, autoPush policy,
  visible save/clear notes. Commit `805b55ba3`, deployed via
  release-web.yml.
- **Related same-day context a fresh session should know**: per-(machine,
  project) render-target defaults (`defaultRuntimeTargetByDevice` + star UI
  + zero-click auto-render in RuntimeLabView), chat transcript groomer
  (`web/lib/runnerTranscript.ts`), turns-hydration fix in the Chat tab,
  agent 1.99.383+ (verbatim follow-ups, wire-capped task payloads),
  owner-dev unmetered on every relay lane. Memory files:
  `project_runner_render_split_design`, `vibe-followup-stuck-fixes-2026-07-27`.

## MISSING — build in this order

### P3a. Web routing: chat → runner device
- Resolve roles: favorite row (+ future per-project override) from
  `GET /settings` — read it where the dashboard already loads settings.
- Task create/continue/stream must address the RUNNER device even while the
  surface is focused on the render device. Web transport is relay-path-
  addressed (`/d/<deviceId>/…`), so the clean shape is a deviceId-scoped
  request mode on `agentClient` (see `fetchAgentPath` and the relay base
  handling around `_activeRelayUrl` in `web/lib/agent-client.ts`) rather
  than a second client instance. The Chat tab (`page.tsx` `handleSend`,
  `selectTask`, SSE subscribe) and RuntimeLabView chat both route through
  `agentClient` today — thread an optional `{deviceId}` through those call
  sites.
- Surface the refusal: if the runner box rejects (guest scope, unauthed
  runner), render the named error — never fall back silently to the
  render box.

### P3b. Web preview → render device + cross-machine reload hop
- Vibing preview (RuntimeLabView `openWebUI` / `createSession` /
  `/dev/*` calls) binds to `renderDeviceId` when roles resolve.
- The completed-turn refresh ("task finished: refreshing Web UI",
  RuntimeLabView) must call the RENDER box's `/dev/reload` (relay path
  `/d/<renderDeviceId>/dev/reload`) — the render box's pre-build-pull
  (`desktop/agent/devserver_pull.go`) picks up the runner's pushed commit.
  Keep the existing reload coalescing (one in flight, queue the rest).
- Header badge: "runner: <name> · render: <name>" on the Vibing chat header
  — two silent sources are two unfalsifiable states.

### P3c. Agent-side (Go)
- Ensure-clone on the runner box: task carries the project's git identity
  (`runtimeProjectCatalogByDevice` rows have repoName/gitRemote/branch);
  if the workDir doesn't exist, clone before spawn. Seam: task placement /
  `effectiveTaskWorkDir` (`desktop/agent/tasks.go`).
- `autoPush` contract: on renderable terminal state, commit; `ask` routes
  through the existing task-question flow (`/tasks/{id}/question`);
  `always` pushes; `never` stops after commit. Then fire the render hop if
  the surface didn't (agent-side hop = `remoteAgentJSONForDevice(ctx,
  renderDeviceId, "POST", "/dev/reload", …)` — but agent doesn't read
  user settings today; simplest is surface-driven hop first).

### P4. Surface parity (same Convex rows, no copies)
- **Mobile**: read `machineRolesByProject` in
  `mobile/src/context/DeviceContext.tsx` (where primaryRunnerByDevice is
  parsed from `/settings`); Settings screen card mirroring the web card;
  task dispatch already supports per-device clients
  (`connectionManager.clientFor`, `multiTargetMode`) — route coding tasks
  to runner, previews to render.
- **tvOS/watch/Wear/car/AR-VR**: read-side only — show the split badge
  where device/task state renders (they consume `GET /settings` +
  device rows; no composer seams there). Key off the account config,
  never a per-surface copy (CLAUDE.md parity rule).
- **render-ssh workspace mode**: LAST — forced-command SSH lane +
  `remote_builder.go` pairing; it is the option, not the spine.

## Verification recipe (end-to-end, the user's real fleet)
1. Settings → runner=ubuntu-4gb (`5e79cf10…`), render=mac-mini
   (`229aeb03…`), workspace=runner-clone, autoPush=ask → save.
2. Vibing → yaver/mobile → send a cosmetic change (e.g. background color).
3. Expect: chat streams from ubuntu; on completion the runner asks to push;
   after push, the mini's pre-build-pull rebuilds and the preview (served
   from the mini) refreshes once. PIXELS = pass; a spinner anywhere =
   file the layer that went silent.
