# Handoff — MCP selection work: `yaver` chip, `includeYaverMcp`, Convex MCP prefs (2026-08-09)

> **Docs drift; code is the source of truth.** Read at HEAD `735873f6f` (pushed to
> `github/main`). Before acting on any row, grep the code again. When this doc and
> the code disagree, the code is the bug.

## 1. What's DONE and committed

### 1.1 `yaver` MCP is now user-selectable (was always auto-injected)
- **Agent** (`desktop/agent/runner_mcp_scope.go`, `tasks.go`, `httpserver.go`,
  `task_fork.go`): new `includeYaverMcp` field (default **true**; `*bool` on the
  wire so old clients stay backward-compatible). When `false`,
  `prepareRunnerMCPScope` skips the `yaver mcp` injection entirely — the runner
  sees ONLY the selected external MCPs (possibly none). Threaded through
  `POST /tasks` and `POST /tasks/{id}/fork`.
- **Web** (`web/lib/agent-client.ts`, `web/components/dashboard/VibeCodingView.tsx`):
  `includeYaverMcp` in `CreateTaskParams` / `buildCreateTaskBody` / `createTask` /
  `forkTask`; a **`yaver` chip** rendered first in the MCP picker (always visible,
  toggleable, shows "yaver (off)" when deselected); threaded into all 5
  taskParams/fork sites.
- **Mobile** (`mobile/src/lib/taskRequestBody.ts`, `quic.ts`,
  `pendingCloudDispatch.ts`, `mobile/app/(tabs)/tasks.tsx`): `includeYaverMcp` in
  send/fork + deferred-cloud params; a **`yaver` toggle row** in the MCP picker.
- Agent tests: `TestCodexYaverOnlyMCPArgsSkipsYaverWhenExcluded`,
  `TestPrepareOpenCodeYaverOnlyConfigExcludesYaverWhenDeselected` — green.

### 1.2 Convex MCP-preference schema (backend compiles clean)
- `backend/convex/schema.ts`: new `mcpServersByDevice` per-device rows
  `{deviceId, mcpServers?, includeYaverMcp?, updatedAt}`.
- `backend/convex/userSettings.ts`: `MCPServersPreference*` types,
  `sanitizeMCPServersPreference`, `mergeMCPServersPreference`
  (replace-by-deviceId), `mcpServersForDevice` arg wired into **both** `set` +
  `setByToken` mutations, plus `patchOwnedDeviceRuntimeProjectCache` touched the
  MCP device.
- `web/lib/runtimeProjectSettings.ts`: `MCPServersPreference` +
  `loadMCPServersFromConvex` + `saveMCPServersToConvex` helpers (same wire shape
  as the keep-last-project pattern).

## 2. What's NOT done — the remaining work

### 2.1 Web boot-read + write-both for MCP prefs (`web/components/dashboard/VibeCodingView.tsx`)
The imports exist (`loadMCPServersFromConvex, saveMCPServersToConvex` at L75) but
are **dead** — nothing calls them. Add:
1. A boot effect (in the settings poll, near the `loadLastProjectFromConvex` call
   ~L915): `const mcpPref = await loadMCPServersFromConvex(CONVEX_URL, token,
   connectedDevice?.id)` → if found, `setIncludeYaverMcp(mcpPref.includeYaverMcp
   ?? true)` + `setSelectedMcpServers(mcpPref.mcpServers ?? [])` (local state =
   fallback).
2. A debounced persist effect: on `selectedMcpServers` / `includeYaverMcp`
   change, `void saveMCPServersToConvex(CONVEX_URL, token, { deviceId,
   mcpServers, includeYaverMcp })` — never block UI on it.

### 2.2 Mobile Convex MCP-pref sync (entirely absent)
- `mobile/src/lib/taskComposerPrefs.ts`: add `saveMCPServersToConvex(token, pref)`
  / `loadMCPServersFromConvex(token, deviceId)` using `getUserSettings` /
  `saveUserSettings` + `mcpServersByDevice` (lazy `await import("./auth")` like
  the keep-last-project helpers, to keep the node test RN-free).
- `mobile/app/(tabs)/tasks.tsx`: boot-read (in the effect near L5106 that already
  reads settings) → set `includeYaverMcp` / `selectedMcpServers`; write-both when
  toggles change (same debounce pattern).
- Note: no local AsyncStorage key for MCP prefs exists — local state is the
  fallback (acceptable; the Convex row is canonical).

### 2.3 Verification
- `cd web && npx tsc --noEmit`
- `cd mobile && npx tsc --noEmit`
- `cd backend && npx tsc --noEmit -p convex`
- `cd desktop/agent && go build . && go test -run "MCP" .`
- Existing tsx tests: `web/lib/goalSlashCommandParity.test.ts`,
  `mobile/src/lib/taskComposerPrefs.test.mts`.
- Chrome automation: extend `e2e/tests/mobile-app-lane-matrix.spec.ts` (or a new
  spec) — drive RN-web at iPhone 15 Pro viewport
  (`browser.newContext({ ...devices["iPhone 15 Pro"] })`), assert: the `yaver`
  chip renders + toggles, deselection sends `includeYaverMcp: false` in the
  POST /tasks body, and the Convex round-trip persists across web↔mobile. Also a
  web-dashboard spec for the chip.
- Test account: `YAVER_TEST_EMAIL` / `YAVER_TEST_PASSWORD` / `YAVER_TEST_TOKEN` /
  `YAVER_TEST_CONVEX_SITE` in `.env.test`; `MOBILE_WEB_URL=http://localhost:8081`
  (expo web already running).

### 2.4 Commit + push to `github` (NOT `origin`)
Remote is `git@github.com:yaver-io/yaver.io.git` (name: `github`). Branch:
`main`. Push with `git push github main`.

## 3. Using the new opencode/deepseek session with yaver MCP `/goal`
- The agent MCP already exposes `create_task` with a `goal` field, and the
  opencode goal plugin (`prevalentWare/opencode-goal-plugin`) is wired via
  `.opencode/opencode.json`. A new session can drive Yaver via `yaver mcp`
  (stdio) or hit `POST /tasks` with `{goal: "<objective>"}` — goal-mode arms
  `<yaver_goal>` on the opencode runner automatically.
- Everything above is testable headlessly (`curl` the agent, tsx unit tests)
  before the Chrome loop — per AGENTS.md, headless first.

## 4. Testimony (verified 2026-08-09)
- Agent: `go build .` clean, `go vet .` clean, 5 MCP-scope tests green.
- Web/mobile: `npx tsc --noEmit` clean on touched files (before the dead-import
  MCP-pref wiring was added — re-run after completing §2.1).
- Backend: `npx tsc --noEmit -p convex` clean.
- Commits: `735873f6f` (and predecessors) on `github/main`.
