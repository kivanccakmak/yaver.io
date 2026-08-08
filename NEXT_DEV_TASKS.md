# NEXT_DEV_TASKS.md — Yaver remaining development (handoff 2026-08-08)

**Owner machine:** ubuntu-4gb-hel1-1 (`runnerDeviceId 2ed7da41-bd6c-4dad-8a13-116756a7ed02`)
**Runner:** opencode · **Model:** deepseek-v4-flash (GLM_API_KEY)
**Repo:** yaver.io @ `main` — the state after this handoff's commit + push

This file is a live task list for the coding agent that continues Yaver
development on the ubuntu box. Work through it top to bottom; commit each
finished task with a conventional message and push.

## Golden rules (from AGENTS.md — read them, they bind)

- `.md` files go stale. **Grep the code before trusting any claim in this
  file.** Every file/line reference here was accurate at handoff time.
- When a doc and the code disagree, the **code wins** — then fix the doc.
- Never commit credentials; the repo is public on GitHub.
- Deploy is owner-only and needs explicit user confirmation — do NOT deploy
  from this box without the user's go-ahead.
- Headless first, then closed loop. Probe the operation, never the inventory.

## What is ALREADY DONE + committed (do NOT redo; verify, then build on it)

1. **Mobile task-creation fix (user-verified working).**
   - `desktop/agent/httpserver.go` `createTask`: the "no prompt" guard now
     accepts a non-empty `title` (the phone's code-mode composer sends the
     instruction in `title` with empty `description`). Refuses only bodies
     where title+description+userPrompt+customCommand are ALL whitespace.
   - `desktop/agent/tasks.go` (~2709): `startProcess` scaffolds the prompt
     from `Title` (falls back Title→Description).
   - `mobile/app/(tabs)/tasks.tsx` + `todos.tsx`: now send
     `description: title` too, so the phone works against ANY agent binary.
   - Tests: `desktop/agent/task_prompt_required_test.go` — all pass.
2. **Raw opencode stdout lane — AGENT SIDE DONE + tested.**
   - `desktop/agent/tasks.go`: `emitRaw()` retains the runner's RAW stdout
     (ANSI + TUI bytes, ungroomed) into `Task.RawOutput`, tail-capped to
     `rawOutputMaxBytes` (512KB) with `rawOutputTruncatedMarker` prepended on
     truncation; live chunks also fan to `rawOutputCh` (append-then-send so
     the retained tail is authoritative when a subscriber drains).
   - `desktop/agent/httpserver.go` `streamOutput`:
     - `?rawSince=<bytes>` → `raw_replay` frame `{type, text, offset, full}`
       (rune-aligned; `full` = snapshot vs increment; `since` past end → full).
     - live `raw` frames `{type:"raw", text, offset}` in the SSE select loop
       (offset = len(RawOutput) AFTER the chunk was retained), chunk-capped.
     - Omitting `rawSince` = byte-for-byte old behaviour (no raw_replay).
   - `getTask` (`taskInfoFromTask`): ships `rawOutput` (last 64KB of the
     retained tail — `taskWireRawOutputCap`) + `rawOffset` (full byte length).
   - Tests: `desktop/agent/task_raw_output_test.go` — 5 tests, all green
     (explicit since replay, omitted-since compat, live raw frames, 512KB
     truncation marker, getTask wire cap + offset).
3. **Console cosmetic:** bg `#000` (`console_embed.go` / `console_static/index.html`).
4. **Web dashboard runner badges** (`web/app/dashboard/page.tsx`): emerald
   "active" styling + "«runner» is working…" text.

## REMAINING TASKS — implement in order

### Task 1 — Web dashboard: opencode TERMINAL (xterm) rendering  [HIGH]

**Goal:** the dashboard chat renders a running opencode task's live TUI the
way a real terminal does (the agent already streams `raw`/`raw_replay`
frames and ships `rawOutput`/`rawOffset` on getTask — this task lands the
consumers).

1. `web/lib/agent-client.ts`
   - `Task` interface: add `rawOutput?: string; rawOffset?: number`.
   - `getTask()`: map both from the response (`t.rawOutput`, `t.rawOffset`).
   - `streamTaskOutput()`: add `opts.rawSince?: number`; append
     `&rawSince=<bytes>` to the SSE URL alongside the existing `since`.
2. `web/lib/taskStreamWithRecovery.ts`
   - `TaskStreamSource.streamTaskOutput` opts + `TaskStreamRecoveryOptions`:
     add `rawSince?: number`.
   - Track a `rawReceived` cursor: update from `raw_replay.offset` and
     `raw.offset` in the internal onEvent wrapper; pass `rawSince: rawReceived`
     on every `subscribe()` and `restart()`.
3. `web/app/dashboard/page.tsx`
   - State `taskViewMode: "chat" | "terminal"` (default `"chat"`) + a small
     segmented toggle in the active-task header, shown ONLY when
     `activeTask.runnerId === "opencode"`.
   - Raw buffer ref (string, cap ~512KB) + raw cursor ref; reset when
     `activeTask?.id` changes.
   - In the existing SSE effect (`streamTaskOutputWithRecovery(...)` call):
     pass `rawSince` for opencode tasks; in the `onEvent` handler add:
     - `raw_replay` `{text, offset, full}`: full → REPLACE buffer, else
       append; cursor = offset; if terminal mounted → write (reset if full).
     - `raw` `{text, offset}`: append buffer (cap), cursor = offset, write to
       terminal.
   - Terminal mount: `<div ref>`; dynamic-import `@xterm/xterm` +
     `@xterm/addon-fit` (same pattern as `web/app/spatial/TmuxPane.tsx`);
     dark theme, `fit()` on resize; on mount write the accumulated buffer;
     for NON-running tasks seed via `agentClient.getTask(tid).rawOutput`
     (one-shot) when the user opens Terminal view.
   - `taskViewMode === "terminal"` renders the terminal instead of the chat
     bubbles area.

**Done when:** a running opencode task shows its live TUI in the dashboard
xterm panel; Chat|Terminal toggle switches; switching away/back reseeds
without duplicates; a completed opencode task's Terminal view shows its raw
tail.

### Task 2 — Console page raw view (`desktop/agent/console_static/index.html`)  [MEDIUM]

Add a per-task "Raw" view: one-shot `GET /tasks/{id}/output?rawSince=0`
(read the `raw_replay` frame, then abort) or live-subscribe; render into the
existing `.terminal-screen` pre (`white-space: pre-wrap`) so ANSI paints raw.
Small toggle on the task detail. No new deps (raw pre-wrap is acceptable).

### Task 3 — Mobile: opencode terminal rendering + cleanup  [HIGH]

1. `mobile/src/lib/quic.ts` `streamTaskOutput`: handle `{type:"raw"}` and
   `{type:"raw_replay"}` frames → new `onRaw?(text, offset, full)` callback;
   add `opts.rawSince` → URL param; track a raw cursor for reattach.
2. `mobile/app/(tabs)/tasks.tsx`: when `selectedTask.runnerId === "opencode"`,
   render an xterm terminal in the task detail — reuse
   `mobile/src/components/XtermView.tsx` (`XtermHandle`, `@xterm/xterm` +
   `@xterm/addon-fit` already in mobile deps) — fed by the raw_replay tail +
   live raw frames, with a Chat/Terminal toggle. Other runners keep the
   current chat. Wire the existing `streamTaskOutput` call (~line 2446) to
   forward raw bytes + cursor. The chat's `stripAnsi` flattening stays for
   non-opencode runners.
3. **CLEANUP:** remove the unused `defaultTaskInputMode` state
   (`mobile/app/(tabs)/settings.tsx` ~283) and the unused
   `UserSettings.defaultTaskInputMode` (`mobile/src/lib/auth.ts`) — grep
   first to confirm no other references before deleting.
4. Do NOT bump the build number manually — the TestFlight script does it.

### Task 4 — Webui: hide redundant provider badge  [MEDIUM]

`web/app/dashboard/page.tsx` collapsed runner summary (~line 4227): suppress
the `providerEntry` chip when `modelDisplay` (lowercased) already contains
the provider label (e.g. "DeepSeek V4 Flash" ⊃ "DeepSeek"). Apply the same
rule in the expanded picker if the duplication exists there. Keep the model
chip.

### Task 5 — Webui: Build|Plan toggle without "Edit"  [MEDIUM]

Same file, collapsed summary row, opencode only: a compact **Build | Plan**
segmented control right in the row (no "Edit ▾" needed). Clicking sets
`setSelectedOpenCodeMode("build"|"plan")` AND persists via the same
`setPrimaryRunner(deviceId, "opencode", model, mode, provider)` call the
expanded picker uses (~line 4548-4562). Default/custom agents stay behind the
Edit picker.

### Task 6 — Verify (headless first, then closed loop)

1. `go build ./... && go test ./desktop/agent/ -run 'TestRaw|TestCreateTask'` — green.
2. Typecheck: web (`npx tsc --noEmit` in `web/`) and mobile (`npx tsc --noEmit` in `mobile/`).
3. Headless: create an opencode task; `curl -H "Authorization: Bearer <token>"
   <agent>/tasks/<id>/output?rawSince=0` → `raw_replay` frame; live `raw`
   frames during the run; `GET /tasks/<id>` → `rawOutput` + `rawOffset`.
4. Closed loop: web dashboard + console + mobile (RN-web at `MOBILE_WEB_URL`,
   REAL device context — `devices["iPhone 15 Pro"]`, never a resized window)
   — an opencode task must paint its TUI in the terminal view on each surface.

## Deploy order (AFTER tasks land + user confirms)

1. `./deploy/deploy.sh web` (cloudflare) — Task 1/4/5 ship here.
2. `./deploy/deploy.sh npm` (agent CLI) — agent-side already done, ships with this push.
3. `./deploy/deploy.sh ios` (TestFlight) — Task 3 mobile rendering ships here (user deploys mobile FIRST by preference).
4. `./deploy/deploy.sh android` optional.
5. NEVER deploy without the user's explicit confirmation.
