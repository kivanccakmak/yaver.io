# GOAL_MODE_HANDOFF_2026-08-09

**Dump for the next session** — everything required, with root causes, evidence,
and prescribed fixes. Work the list in order; every item is independently
verifiable.

---

## 1. Repo state (committed + pushed)

- Branch `main`; remote is **`github`** (`git@github.com:yaver-io/yaver.io.git`) — NOT `origin`. Push with `git push github main`.
- HEAD: `6c9c58881` — `feat: opencode goal-mode + ANSI console across surfaces, safe auto-update, task/MCP plumbing` (82 files, +5869/−275). **Already pushed.**
- What that commit landed (do not redo):
  - `desktop/agent/tasks.go` — `Goal` field on `RunnerConfig`/`Task`/`TaskInfo` + opencode goal-instruction wrapper in `startProcess`; `mcp_tools.go` exposes `goal` in the create-task MCP schema.
  - `desktop/agent/main.go` + `install_versioned_binary_test.go` — auto-update installs to `~/.yaver/bin/<ver>/<plat>/yaver`, exec-probes, atomically repoints `current` symlink (never in-place; macOS 26 code-signing monitor SIGKILLs poisoned paths).
  - `desktop/agent/transfer.go` — **I fixed the compile break**: `TransferTask` now has `Goal string \`json:"goal,omitempty"\`` (was `unknown field Goal`). `go build ./...` + `go vet ./...` pass.
  - `shared/client-core/ansi.ts` + `trace.ts` (+ synced copies in `mobile/src/_core`, `sdk/feedback/react-native/src/_core`, `web/lib/_core`) — shared ANSI tokenizer/classifier + trace assembly. `scripts/sync-client-core.sh` updated.
  - `web/components/dashboard/AnsiConsoleText.tsx` + `mobile/src/components/AnsiConsoleText.tsx` — opencode console look (orange `> build` banners, green `$`, git patches); `hasConsoleMarkup` wired into `web/app/dashboard/page.tsx` `ChatAssistantMsg` (~L1046) and `mobile/app/(tabs)/tasks.tsx` `ChatBubbleImpl` (~L988).
  - Web: `setActiveTask` infinite-loop fix (Maximum update depth exceeded) in `dashboard/page.tsx` (~L1952); xterm remount drain fix (web + mobile).
  - Mobile: full trace copy in Logs panel; opencode terminal lane.
  - `.opencode/opencode.json` — `@prevalentware/opencode-goal-plugin` (project goal-mode plugin).
  - e2e: `e2e/tests/ansi-console-web.spec.ts`, `ansi-console-mobile.spec.ts`, `opencode-terminal-web.spec.ts`.

## 2. Goal / context

User is building **medici.ai** and driving development via Yaver tasks from the
**web dashboard and mobile app**, using **opencode (DeepSeek V4 Flash)** on the
**ubuntu-4gb-hel1-1** box (Hetzner, PRIMARY / AI RUNNER / RENDERER). Wants:
great UI, no failures, project selection in tasks/chat, opencode fully tunable
(build/plan modes, model, session change, API key), opencode-console rendering,
Convex integration, multi-MCP with yaver MCP always default, closed-loop tests.
**No deploys unless the user explicitly asks** (owner-only; mobile/npm need
explicit confirmation). Keep committing + pushing.

## 3. Device-reachability audit — root causes with evidence

Dashboard statuses observed (v1.1.163 · cbcd4e5a7): ubuntu `Reporting in · not
verified` + `Git projects (— unavailable)`; magara `Alive · can't reach (Relay
refused: account relay password missing or stale)`; local MacBook `Alive ·
can't reach (Unauthorized)`; Ofis2/Mobiles-Mac-mini/simkab genuinely offline.

**Measured truth (do not re-derive):**

- `curl -H "Authorization: Bearer $TOKEN" https://yaver.io/d/<id>/info` with the
  token from `~/.yaver/config.json` (`auth_token` key) **returns real JSON for
  ubuntu (`2ed7da41-…`) and magara (`08182df8-…`)** — the server-side same-origin
  relay proxy works. 502 only for genuinely-offline Ofis2 (`8663ea57-…`).
- **Local machine (`6e8db080-a9d0-443c-a55b-b9c385522a97`) returns
  `401 {"code":"relay_password_invalid"}`** via the proxy. Root cause: the local
  agent has **no relay configured** (`yaver get_relay_config` → "No relay
  servers configured"; doctor: "Relay servers ! None configured"), and its
  account-level public endpoints are stale `<uuid>.dev.yaver.io` subdomains.
  The web probe of `/d/<local-id>` then hits the free relay which has no live
  tunnel for it → 401 → classified "Unauthorized".
- Account relay config (from Convex `/config`): `public-free` relay
  `https://public.yaver.io`, password `d763f319…` — valid; the `/d/<id>` proxy
  route (`web/app/d/[deviceId]/[[...path]]/route.ts`) self-heals
  missing/invalid relay passwords via `POST /settings/repair-relay` and then
  **works** (proven above).

**Why cards still show failures despite the proxy working:**

1. **`useDeviceProjects` builds its relay candidate from
   `agentClient.activeRelayUrl`** (`web/components/dashboard/DevicesView.tsx`
   **L2042**), which is **null on this machine** (no relay configured). The
   same-origin candidate `/d/<id>` is what `useDeviceRuntimeInfo` uses
   (**L1700–1709**) and what works. Fix: mirror `useDeviceRuntimeInfo` — always
   push `{ url: \`/d/${device.id}\`, path: "relay" }` when `device.id` exists,
   and only fall back to `agentClient.activeRelayUrl` as a second candidate.
   Same for `useAgentWirelessDevices` (**L1836**).
2. **magara / Ofis2 "Relay refused: account relay password missing or stale"**:
   the classifier (`web/lib/relayAuth.ts` `isRelayCredentialDeny`) matches
   relay-password deny bodies, but when the /d/<id> proxy 401s on a device with
   no live tunnel (magara's tunnel flaps; Ofis2 is off) the route's self-heal
   only repairs **password** issues, not "no tunnel" — so the raw 401 body leaks
   through as "Relay refused". Improvement: when the proxy 401 body says
   `relay_password_invalid` for a device whose agent heartbeats are fresh, the
   web should surface "agent alive but no relay tunnel — restart the agent on
   that box" instead of a password scare. (For the local box the real fix is
   configuring a relay: `yaver relay set-password <pw>` + the agent registering
   a tunnel.)

## 4. Bug backlog — prescribed fixes in priority order

### 4.1 MOBILE: project/MCP chip click does nothing (TestFlight) — THE big one

`mobile/app/(tabs)/tasks.tsx`:
- Chip at **L6122–6141**: `onPress={() => setShowProjectPicker(true)}`.
- Picker is a **second native `<Modal>`** at **L6355**, opened while the
  composer native `<Modal>` (**L5939–6353**) is on screen.
- **Root cause (documented in this exact file, twice)**: iOS cannot present a
  second native `<Modal>` while another is on screen — the newcomer mounts
  invisibly behind it. See the file's own comments at **L1620–1628**
  (LogsPanelContent) and **L4086–4103** ("Modal handoff"). That is precisely why
  the tap appears to do nothing.
- **Fix (mirror the Logs pattern at L7682–7693)**: render the picker sheet as an
  absolute overlay INSIDE the composer Modal —
  `<View style={[StyleSheet.absoluteFillObject, { zIndex: 60 }]} pointerEvents="box-none">`
  gated on `showProjectPicker && showNewTask`, with the sheet + scrim content
  moved from L6355–6461. Keep a standalone `<Modal visible={showProjectPicker && !showNewTask}>`
  as the no-composer fallback (like L7700). Do NOT change `LogsPanelContent`.
- Verify: `npx tsc --noEmit` in `mobile/`; run `e2e/tests/ansi-console-mobile.spec.ts`
  which drives the real composer; manual: tap chip on iOS sim → sheet must open.

### 4.2 MCP: multi-select + yaver MCP always default — mostly DONE, verify only

- Multi-select **already works**: `selectedMcpServers` is `string[]`
  (L1777), toggled in the picker (L6436–6442), sent as `mcpServers` on task
  create (L3999, 4483). Web: `VibeCodingView.tsx` `selectedMcpServers` array.
- yaver MCP always default **already implemented** in
  `desktop/agent/runner_mcp_scope.go`:
  - codex: `--ignore-user-config` + `mcp_servers.yaver.command=yaver mcp`
    (L78–92)
  - claude: `--mcp-config` JSON with `yaver` entry (L94–103, 124–128)
  - opencode: `OPENCODE_CONFIG` scoped file with `yaver` local MCP (L182–217)
  - external MCPs join the same map when allowlisted (`enabledExternalServersFor`).
- **TODO**: (a) verify on ubuntu that a task with `mcpServers: ["<server>"]`
  actually loads yaver + the external server (`opencode` → check
  `~/.yaver/runner-mcp/opencode/opencode.json` during a run); (b) on mobile the
  picker's "No enabled MCP servers registered on this runner" empty state only
  shows servers the agent reports — fine, but confirm `availableMcpServers`
  (`mcpServers` list from L4890 area) is loaded when connected via the
  same-origin proxy (blocked by 4.5 until fixed).

### 4.3 WEB: devices card dumps 153 projects inline — collapse to 3 + unfold

`web/components/dashboard/DevicesView.tsx` `DeviceProjectsRail` (**L5042–5167**)
renders `(projects || []).map(...)` with no cap. The 153 list includes Go module
cache junk (`v2@v2.3.0`, `cdproto@…` — git repos under `/root/go/pkg/mod`).
- Fix UI: compute `gitProjects = projects.filter(p => p.remote)` and
  `topLevel = gitProjects.filter(p => !p.monorepoApp)`; render at most **3
  common** (sort: monorepo apps first? or by name; pick 3) + a
  "Show all (N)" unfold button (local `useState`) that expands the rest into
  the existing chip row. Keep header count `(git / total)`.
- Fix source: agent discovery must stop scanning module caches — see 4.4.

### 4.4 AGENT: discovery scans the whole home dir + Go module cache

`desktop/agent/discovery.go`:
- `projectDiscoveryRoots()` (**L120–164**) falls back to `home` itself
  (**L133**) — on ubuntu `/root` that's everything.
- `desktop/agent/discovery_gitwalk.go` `discoveryGitWalkSkipDirs` (**L30–40**)
  lacks `go`, `pkg`, `mod`, `src`, `.npm`, `.nvm`, `snap`, `.cache` variants.
  Go module cache dirs (`<module>@v<ver>`) are git repos and get listed.
- Fix: add `"go": true, "pkg": true, "mod": true, ".npm": true, ".nvm": true,
  "snap": true, "venv": true, ".venv": true` to the skip map (keep in step with
  `scanMobileProjects` per the file's own comment), and/or in
  `findGitRepoDirsWalk` skip any path containing `@v` followed by digits at the
  same level (module-cache shape). Add a unit test asserting `/root/go/pkg/mod/
  github.com/foo@v1.2.3` is skipped.
- After rebuild, on ubuntu run `curl <agent>/projects` and confirm the junk is
  gone (11 real top-level projects under `/root/Workspace`).

### 4.5 WEB: "no reachable URL" for online machines (useDeviceProjects)

Same as 4.3's root cause but a different consumer: `useDeviceProjects`
(`DevicesView.tsx` **L2028–2160**) hits `candidates.length === 0` →
`setError("no reachable URL")` (**L2107–2113**) because with
`agentClient.activeRelayUrl === null` and https page (no direct candidate) and
no usable https publicEndpoints, the list is empty. Fix: same-origin `/d/<id>`
candidate (see 3.1). This unblocks Git projects on every card AND the mobile
composer's project list (4.2b).

### 4.6 LIVE OUTPUT LOST / Reattach in web chat

`web/components/dashboard/StreamHealthNotice.tsx` + `VibeCodingView.tsx`
(**L584–585, 1125, 3347–3351**): after 5 failed pickup attempts the notice
offers Reattach (bumps `streamReattachNonce`). User hit "LIVE OUTPUT LOST …
could not be picked back up after 5 attempts" while the task kept running on
ubuntu.
- Root cause to verify: the raw SSE lane (`?rawSince=` replay) reconnects to
  `/d/<id>/...` — if the same-origin candidate path isn't what the terminal
  used, or the relay leg flapped, 5 retries exhaust. Check `VibeCodingView`'s
  stream-URL construction and the agent's `raw_replay`/`rawSince` handler
  (`desktop/agent/httpserver.go` search `rawSince`). Goal: the retry loop must
  attempt a **fresh candidate URL** (proxy /d/<id>) per attempt, not the same
  dead URL 5 times, and should auto-recover when the leg returns.

### 4.7 Relay-refused mislabel (magara) — classifier honesty

`web/lib/relayAuth.ts` `isRelayCredentialDeny` (L123–126) + the /d/<id> proxy
self-heal only handle password problems. When the device has no live tunnel the
message mislabels a tunnel outage as a credential issue. Add: if `probeFailed`
reason is relay-credential but `device.online` is fresh, downgrade label to
"no tunnel — restart agent on box" (the machine_doctor summary already says
this: "relay tunnel that's registered but dead").

## 5. Verified-working (do not redo, cite as evidence)

- `/d/<id>/info` proxy → 200 JSON for ubuntu + magara (real token).
- `go build ./...` / `go vet ./...` in `desktop/agent` pass (post transfer.go fix).
- DeepSeek V4 Flash in catalogue: `web/components/dashboard/DevicesView.tsx`
  `OPENCODE_PROVIDER_CATALOGUE` deepseek entry (**L2793–2805**, `deepseek-v4-flash`
  default hint), and `MODEL_OPTIONS_BY_RUNNER` opencode.
- opencode Build|Plan mode segmented control exists on web + mobile
  (`mobile/app/(tabs)/tasks.tsx` L6180–6190 area; web `dashboard/page.tsx`).
- Goal-mode opencode wrapper (`<yaver_goal>`) lives in `startProcess`
  (`desktop/agent/tasks.go`, guarded `runner == opencode && !rawRunnerCommand`).
- Agent MCP scope: yaver MCP default for all three runners (4.2).

## 6. Test commands (run before committing each fix)

- Agent: `cd desktop/agent && go build ./... && go vet ./... && go test ./...`
  (the full suite timed out at 300s earlier — run `go test ./... -short` or
  target packages; don't let it block the commit).
- Web: `cd web && npx tsc --noEmit`
- Mobile: `cd mobile && npx tsc --noEmit`
- e2e: `yaver testkit run --only ansi-console-web` etc., or
  `npx playwright test e2e/tests/ansi-console-*.spec.ts` with `MOBILE_WEB_URL`
  for the mobile lane (see AGENTS.md VIEWPORT rule: real device context).
- Live probe (reachability): token from `~/.yaver/config.json` `auth_token`;
  `curl -H "Authorization: Bearer $TOKEN" https://yaver.io/d/<id>/info`.

## 7. Commit discipline

- One fix per commit; conventional message; include the root cause in the body
  (repo convention: incident → what told you in 10s).
- Push: `git push github main`. Remote is `github`, never `origin`.
- Never commit secrets/tokens. `.coverage.json` stays ignored.

## 8. Explicitly NOT requested (ask before doing)

- No deploys (web/Cloudflare, Convex backend, cli/npm, TestFlight, Play).
- No changes to the mobile native connect path; browser lane is additive-only
  (`.web.ts` siblings / capability checks).
- No touching Ofis2 / Mobiles-Mac-mini / simkab / magara boxes' state; they're
  private LAN / offline — diagnosis only via the dashboard + relay probes.
