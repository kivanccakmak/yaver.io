# Runtime Render Signal Handoff - 2026-07-27

This note is a handoff for Claude Code to review the rerender/signalling change. Code remains the source of truth; grep the referenced symbols before relying on this document.

## Target

When a coding agent changes a project from Yaver chat, the rendered app surface should refresh automatically instead of requiring the user to manually press Fast Reload or recreate a remote runtime session.

The intended contract is:

- A runner task emits normal transcript text as before.
- The Go agent detects render-relevant task output and emits a structured task SSE event.
- Web and mobile clients consume that structured event.
- Active Web UI preview surfaces refresh with the fast reload path.
- Active remote runtime surfaces call `run-guest` on the existing session, so the same simulator/emulator/tvOS/visionOS/etc stream rerenders.
- MCP agents can explicitly call `runtime_command` with `command=run-guest` and `workDir`.

## Implemented

### Go agent signal

Files:

- `desktop/agent/runtime_render_events.go`
- `desktop/agent/tasks.go`
- `desktop/agent/runtime_render_events_test.go`

`TaskManager.emit` now checks every streamed output chunk with `runtimeRenderReasonFromTaskOutput`. On render markers it emits:

```json
{
  "type": "runtime_render_requested",
  "schema": 1,
  "taskId": "...",
  "reason": "web-preview-start | web-bundle-ready | hot-reload | runtime-command | source-change",
  "workDir": "...",
  "snippet": "...",
  "ts": 123
}
```

This rides the existing `Task.eventCh -> /tasks/{id}/output` SSE path, beside `agent_question` and command events. Older clients ignore the unknown event type.

### MCP/runtime command contract

Files:

- `desktop/agent/mcp_tools.go`
- `desktop/agent/httpserver.go`
- `desktop/agent/remote_runtime_mcp_test.go`

`runtime_command` now advertises:

- `boot`
- `run-guest`
- `launch-app`
- `launch-feedback`

The MCP handler parses and forwards `workDir`, so an MCP runner can call:

```json
{
  "sessionId": "rr_...",
  "command": "run-guest",
  "workDir": "/path/to/mobile",
  "source": "mcp"
}
```

### Web Runtime Lab

File:

- `web/components/dashboard/RuntimeLabView.tsx`

Implemented:

- CHAT continues the existing task session until the user closes/deletes it.
- Added session history plus close/delete/new-session controls.
- Added copy icon for Runtime Console.
- Added copy icon for CHAT output.
- Runtime Console can collapse after preview load to give CHAT more vertical space.
- Added browser STT/TTS controls.
- Consumes `runtime_render_requested` from task SSE.
- On render request:
  - refreshes active Web UI preview with fast reload;
  - calls `sendRemoteRuntimeCommand(session.id, "run-guest", "web-auto-render", workDir)` for active remote runtime sessions.
- Keeps transcript-marker detection as fallback for older agents that only print markers.

### Mobile UI

Files:

- `mobile/src/lib/quic.ts`
- `mobile/src/lib/feedbackTrigger.ts`
- `mobile/app/remote-runtime.tsx`
- `mobile/app/(tabs)/tasks.tsx`

Implemented:

- `sendRemoteRuntimeCommand` now supports `boot | run-guest | launch-app | launch-feedback`.
- It accepts `workDir` and `bundleId` payload fields.
- The remote-runtime screen now registers the full active session, not just the session id.
- The Tasks screen consumes `runtime_render_requested` from task SSE.
- On render request, mobile calls `rerenderActiveRemoteRuntimeSurface`, which issues `run-guest` against the active remote runtime session and logs success/failure in the app log.

## Surface Audit

Supported automatic rerender targets are exactly the targets the Go agent currently accepts in `isRNSimulatorTarget`:

- `ios-simulator`
- `ipados-simulator`
- `watchos-simulator`
- `tvos-simulator`
- `visionos-simulator`
- `android-emulator`
- `android-wear`
- `android-tv`
- `android-xr`
- `android-auto`
- `android-redroid`

Covered client surfaces:

- Web dashboard Runtime Lab: consumes the structured task event and triggers Web UI reload or remote `run-guest`.
- Mobile Tasks tab: consumes the structured task event and triggers remote `run-guest` for the active remote-runtime screen session.
- Mobile remote-runtime screen: keeps active session metadata for phone/tablet/watch/tv/vision/XR/car/emulator/redroid targets.
- MCP: can call `runtime_command` `run-guest` directly with `workDir`.

Not claimed:

- Physical `ios-device` / `android-device` remote sessions are stream/control targets, but the Go agent currently rejects `run-guest` for them. The clients deliberately do not claim automatic guest rebuild for those physical-device targets.
- Generic `browser-window`/`desktop-screen` sessions are not RN guest build targets. Web preview refresh is handled separately in Runtime Lab.

## Why This Should Work

The trigger is now at the daemon task-stream layer, not just a React heuristic. A runner output marker such as `yaver_web_preview_start`, `Web UI bundle rebuilt`, `run-guest`, `hot reload`, or source-edit text produces a structured event. Both web and mobile task views already subscribe to the same `/tasks/{id}/output` SSE stream, so the event reaches both surfaces without adding a second channel.

Remote surface rerender stays on the existing remote runtime command endpoint:

```text
POST /remote-runtime/sessions/{id}/command
```

with:

```json
{ "command": "run-guest", "source": "...", "workDir": "..." }
```

The Go command path already does the actual build and relaunch asynchronously, updating the existing session status to `building` and then `streaming` or `build-failed`.

## Verification

Passed:

- `web`: `npx tsc --noEmit`
- `mobile`: `npx tsc --noEmit`
- `git diff --check` for touched files
- `gofmt` on touched Go files

Completed in review (2026-07-27, Claude Code):

- The focused `go test` run below did NOT hang on retry (finished in <1s with `-timeout 120s`); the earlier hang was environmental, but it had masked a genuine FAILURE: `runtimeRenderReasonFromTaskOutput` did not match `"Web UI bundle rebuilt: N files."` — the exact string `RuntimeLabView.tsx` prints. Fixed by adding the `bundle rebuilt` marker to the `web-bundle-ready` case.

```sh
cd desktop/agent
go test . -run 'TestRuntimeRender|TestRuntimeCommandRequestParsesBundleIdAndWorkDir' -count=1 -v -timeout 120s
```

## Claude Code Review Checklist

1. Confirm `runtime_render_requested` is emitted only from task-local SSE and does not enter Convex payloads.
2. Confirm `run-guest` remains rejected for unsupported targets rather than silently claiming physical device rerender.
3. Confirm mobile and web target allowlists match `isRNSimulatorTarget`.
4. Confirm a task producing `yaver_web_preview_start` causes:
   - Web Runtime Lab fast reload when Web UI preview is open.
   - Mobile Tasks tab `run-guest` when a remote-runtime session is active.
5. Confirm repeated output chunks do not trigger unbounded rebuild loops. Web dedupes by task/status/line count/request id; mobile fires per event. As originally written the claimed "daemon command idempotence" DID NOT EXIST — every `run-guest` spawned another 20-minute build goroutine on the same workDir. Fixed in review: the handler now atomically claims the `building` state and answers further `run-guest` commands with `202 {deduped:true}` while a build is in flight (`remote_runtime.go`, guard test `TestHandleRemoteRuntimeSessionCommand_RunGuestDedupesWhileBuilding`).
6. Target-allowlist drift (Go `isRNSimulatorTarget` vs the two client `canRunGuestOnRemoteTarget` copies) is now guarded by `desktop/agent/runtime_render_target_parity_test.go`, which reads all three sources. Both new tests were proven by breaking them.
