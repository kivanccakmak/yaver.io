# NEXT_DEV_TASKS.md — Yaver remaining development (handoff 2026-08-08, post-session)

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
- **A parallel session is active on this repo** (fork-path `allowLocalFallback`
  work). Re-check `git status` immediately before any commit and stage only
  your files; do not sweep their work into yours.

## What is DONE + committed (2026-08-08 session — do NOT redo; verify, then build on it)

1. **Mobile opencode terminal view — `19a83549e`** (Task 3 complete):
   - `mobile/src/lib/quic.ts` — `streamTaskOutput` gains `opts.rawSince` +
     `opts.onRaw(text, offset, full)`; `&rawSince=` beside `since`; `raw` /
     `raw_replay` frames routed. Omitting `rawSince` = old stream.
   - `mobile/src/components/XtermView.tsx` — `reset()` on `XtermHandle`
     (`__yvReset` → `term.reset()`) for full-snapshot replaces.
   - `mobile/app/(tabs)/tasks.tsx` — opencode Chat|Terminal toggle + xterm
     render branch; per-task raw buffer/cursor refs; single shared raw sink
     (`handleRawChunk` / `drainRawToTerminal`); live SSE wiring with reattach
     cursor; one-shot seed for finished tasks. Terminal is READ-ONLY.
   - Cleanup: `defaultTaskInputMode` removed (`auth.ts`, `settings.tsx`).
2. **Web dashboard opencode terminal — `25c8b6fe3`** (Tasks 1/2/4/5):
   - `web/app/dashboard/page.tsx` — `raw_replay`/`raw` SSE frames → xterm.js
     (`RawTaskTerminal`); Chat|Terminal toggle (opencode only); finished-task
     seed via `getTask().rawOutput`; per-task cursor/buffer reset; window
     resize fit; provider chip suppressed when the model label already names
     the provider; compact **Build|Plan** segmented control in the collapsed
     runner summary (persists via `setPrimaryRunner`).
   - `web/lib/agent-client.ts` (rawSince hunks) + `web/lib/taskStreamWithRecovery.ts`
     — `rawSince`/`rawOutput`/`rawOffset` transport + cursor tracking.
   - `desktop/agent/console_static/index.html` — per-task **Raw** view:
     one-shot `?rawSince=0` tail + Live subscribe into the `.terminal-screen`
     pre (ANSI intact).
3. **Mobile logs-sheet fix — `d6d9e6281`** (committed before the session's
   raw-lane work): Logs sheet renders inside the task-detail modal (iOS
   cannot stack a second native Modal), runner·model label on task cards.

## Verification status

- `go build ./...` + `go test ./desktop/agent/ -run 'TestRaw|TestCreateTask|TestHandleTaskFork'` — **green**.
- `web` tsc (`npx tsc --noEmit`) — **clean**.
- `mobile` tsc — clean EXCEPT pre-existing errors on HEAD (not this
  session's): `src/components/TaskProofCard.tsx` (13 errs — concurrent WIP,
  see `docs/audits/attachable-mode-self-dogfood-audit-2026-08-02.md`),
  `src/context/DeviceContext.tsx:2937` (1), `.test.ts` URL-type errors (3).
  Do not "fix" these here; they belong to their own sessions.
- **NOT YET DONE:** Task 6 headless SSE probe + closed loop (below).

## REMAINING TASKS

### Task 6 — Verify the terminal views (headless first, then closed loop)

1. **Headless:** create an opencode task on a box; then
   - `curl -H "Authorization: Bearer <token>" <agent>/tasks/<id>/output?rawSince=0`
     → a `raw_replay` frame (`full=true`) with the raw tail;
   - during the run, live `raw` frames arrive;
   - `GET /tasks/<id>` → `rawOutput` + `rawOffset` present.
2. **Closed loop — web:** dashboard → opencode task → Terminal view → the TUI
   paints (judge on PIXELS); toggle Chat|Terminal away/back → no duplicates; a
   completed opencode task's Terminal shows its raw tail.
3. **Closed loop — mobile:** RN-web at `MOBILE_WEB_URL` in a REAL device
   context (`devices["iPhone 15 Pro"]`, never a resized window) — same checks.
4. **Console:** `GET /app` on the agent → Recent Tasks → Raw → tail paints;
   Live streams during a run.

### After verification (needs user's go-ahead — deploy is owner-only)

1. `./deploy/deploy.sh npm` (agent CLI — raw lane already in 1.99.406+).
2. `./deploy/deploy.sh web` (cloudflare) — Tasks 1/4/5 ship here.
3. `./deploy/deploy.sh ios` (TestFlight) — Task 3 mobile rendering ships here
   (user deploys mobile FIRST by preference). Do NOT bump the build number —
   the TestFlight script does it.
4. `./deploy/deploy.sh android` optional.

## NOT this session's work — do not claim/commit

- **Parallel session's fork-path work, uncommitted in the tree (2026-08-08):**
  `desktop/agent/task_fork.go` + `task_fork_test.go` (`AllowLocalFallback` on
  fork), `desktop/agent/tasks.go`, `web/components/dashboard/VibeCodingView.tsx`
  (fork sends `allowLocalFallback: true`), the remaining fork hunks in
  `web/lib/agent-client.ts` (forkTask `allowLocalFallback` +
  `decodeCloudWorkspaceRequiredError`), and
  `docs/architecture/TASK_MCP_PROJECT_SELECTION.md` (untracked). Their commit;
  not yours.
- Session trail: `docs/audits/opencode-terminal-session-2026-08-08.md`.
