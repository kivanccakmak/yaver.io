# opencode terminal views — session audit (2026-08-08)

Session scope: land the consumer side of the agent's raw opencode stdout lane
(`d671b7c02` — raw `SSE` frames, `?rawSince=` replay, `rawOutput`/`rawOffset`
on getTask) across mobile, web, and the console page. The agent side was
already done + committed at session start; this session is the
`NEXT_DEV_TASKS.md` (handoff 2026-08-08) consumer work.

Read this the way AGENTS.md says to read every `.md`: **the code wins, the doc
drifts.** File:line refs below were accurate at write time.

## What shipped this session

### Committed
- `d6d9e6281` — mobile WIP landing: Logs-sheet renders inside the
  task-detail modal (iOS cannot stack a second native `Modal` on top of the
  task-detail one — the newcomer mounted invisibly and the Logs button "did
  nothing"; 2026-08-08) + runner·model label on task cards. Includes the
  `ThemeColors` import fix (was imported from `ThemeContext`, which does not
  export it — the type lives in `src/constants/colors`).

### Uncommitted at time of writing — mobile (Task 3)
- `mobile/src/lib/quic.ts` — `streamTaskOutput` opts gain `rawSince?: number`
  and `onRaw?: (text, offset, full) => void`. URL appends `&rawSince=` beside
  `since`; `raw` / `raw_replay` frames route to `onRaw`. Omitting `rawSince`
  is byte-for-byte the old stream (no raw_replay frame, no raw frames) — the
  chat path and dogfood are untouched.
- `mobile/src/components/XtermView.tsx` — `XtermHandle` gains `reset()`
  (`window.__yvReset` → `term.reset()`) for raw_replay full-snapshot
  replaces. Additive; no native change.
- `mobile/app/(tabs)/tasks.tsx` — opencode Chat|Terminal toggle (opencode
  tasks only; other runners keep the plain chat), `XtermView` render branch
  replacing the chat `FlatList`, per-task raw buffer/cursor refs
  (`rawBufRef`/`rawWrittenRef`/`rawCursorRef`/`rawTaskIdRef`), a single
  shared raw sink (`handleRawChunk` + `drainRawToTerminal` — one copy, no
  drift), live SSE wiring (`subscribe(since, rawSince)`, reattach passes the
  raw cursor, per-task buffer reset), and a one-shot seed for FINISHED
  opencode tasks (subscribe `rawSince=0`, drain the raw_replay snapshot,
  abort). Terminal is READ-ONLY — opencode runs on the box.

### Uncommitted — web (Task 1), from an earlier session, unwired
- `web/lib/agent-client.ts` — `Task.rawOutput`/`rawOffset` + `getTask`
  mapping; `streamTaskOutput({ rawSince })`.
- `web/lib/taskStreamWithRecovery.ts` — `rawSince` threaded through + a
  `rawReceived` cursor updated from `raw_replay.offset` / `raw.offset`.
- `web/app/dashboard/page.tsx` — `RawTaskTerminal` (xterm.js) component +
  `RawTermHandle` EXIST but are **not wired**: no Chat|Terminal toggle, no
  SSE raw handling, no cursor, no getTask seed-on-open.

### Uncommitted — parallel session (NOT this session's work; dated 2026-08-08)
- `desktop/agent/task_fork.go` + `task_fork_test.go` — fork-path
  `AllowLocalFallback` (a fork opts out of Cloud Workspace placement
  deferral and runs locally; test `TestHandleTaskForkAllowLocalFallbackRunsLocally`).
- `web/components/dashboard/VibeCodingView.tsx` — fork sends
  `allowLocalFallback: true`.
- ⚠️ The ubuntu box (`ubuntu-4gb-hel1-1`) appears to be editing this repo
  concurrently. **Commit only explicitly-staged files; re-check `git status`
  immediately before committing.**

## Pre-existing errors (on HEAD, NOT introduced this session)
Mobile `tsc --noEmit` was already red on `main`:
- `src/components/TaskProofCard.tsx` — 13 errors (references `TaskProof`,
  `proofStatus`, `commitSha`, … — untracked/concurrent WIP per
  `docs/audits/attachable-mode-self-dogfood-audit-2026-08-02.md`).
- `src/context/DeviceContext.tsx:2937` — `UserSettings` shape mismatch.
- 3 `.test.ts` URL-type errors (node type drift).

Do not "fix" these as part of this work; they belong to their own sessions.

## NEXT_DEV_TASKS.md status at write time
| Task | Verdict |
|---|---|
| 1 Web terminal | 🔶 ~40% — transport done, page.tsx wiring/toggle missing |
| 2 Console raw view | ❌ not started |
| 3 Mobile terminal + cleanup | 🔶 ~90% impl'd; was NOT compiling (unclosed ternary after the chat `FlatList` `/>`) — see below |
| 4 Hide redundant provider badge | ❌ not started |
| 5 Build\|Plan toggle | ❌ not started |
| 6 Verify | ❌ not started |

## Landed after this dump (fill in as they land)
- [ ] Task 3 ternary closed + mobile tsc green (only pre-existing errors)
- [ ] Task 3 cleanup: `defaultTaskInputMode` removed (`auth.ts`, `settings.tsx`)
- [ ] Mobile commit (Task 3) landed separately from web/parallel work
- [ ] Task 1 web page.tsx wiring landed
- [ ] Task 2 console raw view landed
- [ ] Task 4 provider-badge dedup landed
- [ ] Task 5 Build|Plan toggle landed
- [ ] Task 6 verification (headless SSE probe + closed loop) noted
- [ ] `NEXT_DEV_TASKS.md` rewritten to the post-session state
