# Runner/Render Machine Split — deep audit + architecture

**Status: design, grounded in a code audit (2026-07-27). Nothing here is
implemented as a product feature yet; §2 lists what already exists with
file:line, §3 the genuine gaps, §4 the design. Per CLAUDE.md, if this doc
disagrees with the code, the doc is the bug.**

## 1. The use case, verbatim from the field

The user's real fleet today:

- **ubuntu-4gb-hel1-1** (Linux/arm64, Hetzner): runners are healthy —
  `claude(auth), codex(auth), opencode(glm)`. No Xcode, no useful RAM for
  mobile builds, no iOS/Flutter deploy capability.
- **Mac mini** (8GB, always-on): has the source checkouts, Xcode, iOS
  deploy, Flutter capability — but coding-agent TUIs are chronically awkward
  there (claude unauthed, tmux/TUI traps; see memory
  `project_mac_mini_autorun_state`).

Wanted: an **optional, explicitly-configured slicing** where
- the **AI runner machine** executes the coding task (vibing chat streams
  from it),
- the **render machine** holds/serves the app — dev server, web-bundle,
  simulator, WebRTC stream, store deploys — and re-renders when the task
  lands,
- the **client surface — any of them** (web dashboard, phone, tablet, TV,
  AR/VR) is fed from **two sources at once**: chat/task stream from the
  runner box, preview stream from the render box,
- the runner works on **its own clone or the remote code, whichever is
  optimal**, but the convergence contract is **git**: commit → (with the
  user's guidance) push → the render box syncs from the remote,
- defaults live in **account settings** ("favorite configuration": ubuntu-4gb
  = default AI runner, mac mini = default renderer), like the per-machine
  runner and the per-(machine, project) render target that already exist,
- Kotlin/Swift/native testing lanes render the same way (`native-webrtc`),
  since those can never load into a browser or the Hermes container.

## 2. Deep audit — what exists today

### 2a. Task placement & dispatch (the "which machine runs the AI" half)

- Tasks are machine-addressed already. Web builds a placement request with
  `targetDeviceId`, `sourceSurface`, `requestedRunner`, resource-class hints
  (`web/app/dashboard/page.tsx` `handleSend` → `previewTaskPlacement`), and
  Convex records dispatch intents that a surface can complete later when the
  target box connects (mobile: `listTaskDispatchIntents` /
  `updateTaskDispatchIntent` / `pendingCloudDispatch*` in
  `mobile/app/(tabs)/tasks.tsx` ~2210–2320).
- The agent runs tasks strictly against a **local** workDir
  (`desktop/agent/tasks.go` — `effectiveTaskWorkDir`, `startResume`); there
  is **no notion of "run here against code there"** anywhere in the task
  manager. That's the core missing primitive — and §4 argues it should NOT
  be added; git is the seam instead.
- One agent can drive another over HTTP today:
  `remoteAgentJSONForDevice(ctx, deviceID, method, path, body, &resp)` —
  41 non-test call sites (e.g. `desktop/agent/code_control.go:1779`) — and
  the `ops` MCP layer proxies verbs to devices (`proxyToDevice`,
  `desktop/agent/httpserver.go:6489`). Peer tool calls also exist as
  first-class MCP verbs (`acl_list_peer_tools`, `acl_call_peer_tool`;
  `desktop/agent/mesh_acl.go`).

### 2b. Networking stack (how the two boxes reach each other)

Yaver already has a full machine-to-machine ladder; the split invents **no
new transport**:

- **SSH lanes** with the multi-tenant invariants: forced-command cages (no
  shell/pty/forward — `ssh_control_server.go`, `ssh_session_cmd.go`),
  `# yaver-managed` key sets (`ssh_managed_keys.go`), reverse-SSH over the
  QUIC relay (Phase A, both directions — `ssh_relay_bridge.go`,
  `ssh_reverse_tunnel.go`), and target resolution
  LAN-on-subnet → Tailscale (gated on a live 100.x interface) → device row →
  ssh config (`ssh_targets.go`, `ssh_resolve_lan.go`).
- **Yaver Mesh** (WireGuard, default-on hardening) with mesh ACLs and DERP
  fallback (`mesh_agent.go`, `mesh_acl.go`, `mesh_derp_transport.go`).
- **Relay**: any owned device is reachable at
  `/d/<deviceId>/<path>` with per-user password + bearer, account-scoped
  bridging only, owner-dev unmetered on every lane stamped at tunnel
  registration (`relay/server.go` — see
  memory `public-relay-deploy-drift`). The signed preview URL the render box
  hands out (`/d/<id>/dev/web-bundle/?exp=…&sig=…`) already traverses this.
- **`devserver_pull.go` — the git seam is LIVE.** Before every web-bundle
  build the render box runs `git pull --rebase --autostash` with a logged
  decision (`devserver_pull.go:261`). The user's own runtime console shows
  it firing before each render. **A commit pushed by a runner anywhere
  already reaches the render box's next build with zero new code.**

### 2c. Render pipeline (the "which machine serves the app" half)

- Dev servers, web-bundle export, Hermes build, simulator/WebRTC streams all
  run on the box that owns the workDir (`devserver.go`, `devserver_http.go`,
  `remote_runtime.go`).
- Render intents are already events: task output → `runtime_render_requested`
  (`runtime_render_events.go:40`, reasons parsed at `:7`) consumed by
  surfaces via the task stream (web `RuntimeLabView` `attachTaskSession`
  onEvent) and `/dev/events` SSE — with the cross-surface "queue → quiet
  status → one final render" policy (CLAUDE.md).
- `POST /dev/target` (`devserver_http.go:1592`) already records a *target
  device* for previews (today: which phone/display receives it).
- **`remote_builder.go` is the split's ancestor**: a local (privacy-scoped,
  `~/.yaver/builders.json`, deliberately NOT in Convex) registry of paired
  remote-Mac builders that a Linux host dispatches iOS/Swift build+run
  sessions to; `--builder-platforms=ios` advertises the Mac side
  (`main.go` serve flags). Kotlin/Swift/native testing lanes are
  `native-webrtc` by design (CLAUDE.md validation-apps table) — they stream
  pixels from wherever the build runs; they never load into a browser.

### 2d. Account-side config layer (where "favorite configuration" lives)

The pattern is established and was extended twice today:
`primaryRunnerByDevice` (runner+model per machine),
`defaultRuntimeProjectByDevice` (project per machine),
`defaultRuntimeTargetByDevice` (render target per machine+project; identity
only, no URLs/ports/serials) — all in `backend/convex/userSettings.ts` +
`schema.ts`, written via `POST /settings`, read by every surface via
`GET /settings`. A machine-ROLE preference is one more row family in the
same shape.

### 2e. Client multi-source capability (surfaces fed from two boxes)

- **Mobile already does it**: `connectionManager.clientFor(deviceId)` holds a
  per-device client pool, `multiTargetMode` + `connectedDeviceIds` are real
  state (`mobile/src/context/DeviceContext.tsx:985,1137`;
  `mobile/app/(tabs)/tasks.tsx` dispatches to `targetClient` ≠ focused
  client).
- **Web** holds one `agentClient`, but every request is path-addressed
  through the relay (`/d/<deviceId>/…`), so "second source" on web is a URL
  choice, not a new transport: the preview iframe already points at a signed
  `/d/<renderDeviceId>/dev/web-bundle/` URL while the chat SSE points at
  `/d/<runnerDeviceId>/tasks/<id>/output`. The two-source model is latent in
  the addressing.

### 2f. Git sync & guidance (the convergence contract)

- Render side: pre-build-pull (2b) — done.
- Runner side: runners commit/push under the repo's own rules; Yaver's
  managed-git layer (`managed_git_*` verbs) and forge seam exist for
  checkpoint/mirror. "Push with the user's guidance" maps to the existing
  ask/approve seams (`yaver_ask_user`, task `question` flow) rather than
  auto-push.

## 3. The genuine gaps (everything else exists)

1. **No machine-role config**: nothing says "runner=ubuntu, render=mini" —
   per account, per project, optional. (One new Convex row family.)
2. **Task creation doesn't consult it**: surfaces send tasks to the
   *connected/focused* device; there's no "route the coding task to the
   runner machine while I stay focused on the render machine".
3. **Render trigger doesn't cross machines**: `runtime_render_requested`
   from a task on box A never reaches box B's dev server. The completed-turn
   → refresh loop is single-box. (The git seam carries the *content*; the
   *event* needs one hop: on renderable terminal state, the runner box —
   or the surface — calls `POST /d/<renderDeviceId>/dev/reload` guarded by
   the existing reload-coalescing.)
4. **Runner workspace bootstrap**: on the runner box, the project may not be
   cloned yet. Needs "ensure clone of <gitRemote> at <branch>" (the
   `runtimeProjectCatalog` rows already carry repoName/gitRemote/branch —
   privacy-safe identity, no paths).
5. **Push-with-guidance policy**: a per-config flag (`autoPush: never |
   ask | always`) enforced at the runner box, defaulting to ask via the
   existing task-question flow.
6. **Web two-source wiring**: chat panel pinned to runner device, preview
   pane pinned to render device (mobile's pool already allows it; web needs
   the second base-URL plumbed through the preview/iframe code path — it is
   already device-addressed internally).
7. **UI plumbing on every surface** for the optional config: a "Machine
   roles" section (Settings) + a badge on the Vibing header ("runner:
   ubuntu-4gb · render: mac-mini"). Native surfaces read the same
   `GET /settings` rows (cross-surface parity by construction — key off the
   account config, never a per-surface copy).
8. **SSH keep-alive lane (optional)**: "ubuntu will make ssh keep vibing" —
   for the case where the runner should operate directly on the render box's
   working tree instead of its own clone, the forced-command SSH lane +
   builder-registry pairing is the transport; this is the OPTIONAL variant,
   not the default (see §4.2).

## 4. Design

### 4.1 Principles

- **Optional slicing.** Zero configuration = today's behavior, bit for bit.
  The split activates only when the user creates a machine-role config.
- **Git is the spine; SSH is the option.** Two working modes per config:
  - `workspace: "runner-clone"` (default): the runner works on its own
    clone (robust — no cross-machine FS coupling, fast local edits),
    converges via commit → push (guarded) → render box pre-build-pull.
    This mode is ~80% plumbed already (§2b).
  - `workspace: "render-ssh"`: the runner operates on the render box's tree
    over the forced-command SSH lane (for uncommittable spikes / huge repos
    where a second clone is wasteful). Slower per-edit, no divergence risk.
  The config chooses; "whichever is optimal" is a policy default (small
  repo + good link → runner-clone), never a silent auto-switch mid-task.
- **Two sources, one account.** A surface holds a chat lane to the runner
  device and a preview lane to the render device. Same bearer, same relay
  addressing, same owner entitlement (already account-keyed on every lane).
- **Security unchanged.** No new trust: relay stays pass-through +
  access-graph-scoped; SSH stays forced-command + `# yaver-managed` keys;
  builder registry stays local-only (hostnames/tokens never in Convex);
  Convex stores role *identity* only (deviceIds, project name, mode flags).

### 4.2 Config schema (Convex, follows the established row families)

```
machineRolesByProject: [{
  projectName?: string,        // absent = account-wide favorite
  runnerDeviceId: string,      // AI runner machine
  renderDeviceId: string,      // render/workspace machine
  workspace: "runner-clone" | "render-ssh",
  autoPush: "never" | "ask" | "always",   // guidance contract
  updatedAt: number,
}]
```

Favorite = the row without `projectName` (user's: runner=ubuntu-4gb,
render=mac-mini). Per-project rows override, exactly like
`defaultRuntimeTargetByDevice` scoping.

### 4.3 Flows

**Task flow (runner-clone mode)**
1. Surface sends prompt → placement consults `machineRolesByProject` →
   task lands on `runnerDeviceId` with the project's git identity
   (repoName/gitRemote/branch from the catalog rows).
2. Runner box ensures the clone (gap 4), runs the turn. Chat streams to the
   surface from the runner box (existing task stream).
3. Turn reaches a renderable terminal state → runner box (a) commits;
   (b) per `autoPush`: pushes, asks via task-question, or stops; (c) on
   push, emits the cross-machine render hop (gap 3):
   `POST /d/<renderDeviceId>/dev/reload` — which pre-build-pulls, rebuilds,
   and the surface's preview lane (already pointed at the render box)
   refreshes under the existing one-final-render policy.

**Render flow** — unchanged from today except its box is chosen by config:
web-bundle/iframe for web projects, Hermes for RN in the Yaver container,
`native-webrtc` for Kotlin/Swift/Flutter-native testing (the mini builds and
streams; `remote_builder.go` pairing covers the Linux-drives-Mac case).

**Surface flow** — chat pane binds `runnerDeviceId`, preview pane binds
`renderDeviceId` (mobile: two pool clients — exists; web: second
`/d/<id>/` base for the preview lane — plumbing only). The Vibing header
names both, because two silent sources are two chances to be unfalsifiable.

### 4.4 Implementation phases

- **P0 (works today, zero code)**: manual version of the whole loop —
  dispatch the task to ubuntu (device picker), keep the Vibing preview on
  the mini, let the runner push and the mini's pre-build-pull pick it up on
  the next reload tap. Only the automatic cross-machine reload is missing.
- **P1**: Convex `machineRolesByProject` + Settings UI (web first) — the
  favorite configuration.
- **P2**: placement honors `runnerDeviceId`; runner-side ensure-clone;
  `autoPush` contract via task questions.
- **P3**: cross-machine render hop + web two-source preview binding; Vibing
  header badge.
- **P4**: mobile/tablet parity (pool already supports it), then TV/AR-VR
  read-side; `render-ssh` workspace mode last (it's the option, not the
  spine).

## 5. What this deliberately does NOT do

- No shared/remote filesystem layer, no rsync daemons: git carries content.
- No relay-side smarts: the relay keeps forwarding ciphertext by deviceId.
- No auto-push without the user's standing instruction (`autoPush: always`
  is explicit, per config, per project).
- No silent auto-switching of workspace mode mid-task.

## 6. Fast lane: patch streaming (design, 2026-07-27 — user-directed)

Two clones exist by design — one on the vibing (runner) box, one on the
render box. Git push→pull is the DURABLE spine, but its latency per vibing
turn is real: commit (~0.1-0.5s) + push (~1-4s to a forge) + render-side
pull (~1-3s) + rebuild. For "type → see pixels" loops the sync should not
be gated on a forge round-trip. The fast lane:

1. **Runner side** after each coding turn (or on file-change debounce):
   `git diff [--binary] > patchN.diff` — N monotonic per session, name
   carries taskId + seq (`task-<id>-p<seq>.diff`) so ordering and replay
   are self-evident.
2. **Transfer**: the agent-to-agent authed HTTP lane over the relay
   (`/d/<renderDeviceId>/dev/apply-patch`, bearer + same-owner) — the
   Yaver-native equivalent of the user's scp sketch (port 22 is the
   forced-command cage; HTTP relay is the lane that already exists on
   every box). One hop, ~100-300ms.
3. **Render side**: `git apply --3way --whitespace=nowarn patchN.diff`
   onto the SAME base commit, then debounce-rebuild the browser lane.
   Patches apply to the working tree only — the render box's git history
   stays clean; the next real push→pull supersedes applied patches
   (`git checkout -- .` before the pull, sequence guarded).
4. **Alignment precondition (session start)**: both clones must agree —
   same branch, same HEAD (`git rev-parse HEAD` + `git log --stat -1` as
   the human-readable witness). If they disagree: ff-pull the stale side;
   if diverged, rebase the render clone onto the runner's HEAD (render
   clone is disposable working state, runner clone is authoritative
   during a vibing session). Refuse the fast lane (named) until aligned.
5. **Main-branch-production principle**: vibing runs on `main` unless the
   project config says otherwise — commits land on main, pushes go to
   main, the render box tracks main. No hidden integration branches.

Speed budget (target): diff 20-80ms · relay hop 100-300ms · apply
20-50ms · web-js-bundle warm rebuild 1-3s → **~1.5-3.5s turn-to-pixels**,
vs ~6-12s via forge push→pull. The durable spine still runs underneath
(autoPush policy unchanged); the patch lane is an optimization, never the
source of truth.

MCP surface: `runner_patch_send` (runner box, produces + ships patchN) and
the render box's `/dev/apply-patch` (applies + triggers coalesced reload).
Guests: never — owner bearer only, same-owner relay scope.

Status: DESIGN. Prereqs landed: ensure-clone, autoPush converge,
pre-spawn ff-pull, cross-machine reload hop.
