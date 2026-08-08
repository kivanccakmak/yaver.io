# Medici via Yaver Mobile Task Audit — 2026-08-08

Scope: use Yaver from the mobile RN-web surface to pick the Medici project, run on the Hetzner Ubuntu 4 GB Cloud Workspace box with OpenCode/DeepSeek-style fast model config, keep remote output as a real console stream, and avoid leaking project/user MCPs unless explicitly selected.

Important correction: this is not a MacBook-local task. Both machines may have source code, but the runner is the Ubuntu box. Any absolute path from this Mac, such as `/Users/kivanccakmak/Workspace/medici.ai`, is only a hint. The durable selector must be portable project identity (`medici.ai`, project slug, git remote/branch), and the Ubuntu agent must resolve that to its own local checkout path.

## Verdict

Partially implemented; release readiness still depends on closed-loop mobile/TV verification and the TestFlight build.

The Cloud Workspace 409 screenshot is fixed in the current working tree for forks: fork requests support `allowLocalFallback`, web and mobile pass it, and mobile decodes `cloud_workspace_required` instead of only showing raw `Failed to fork task: 409`. The project/MCP workflow is now implemented in the task wire path:

- Mobile task creation sends portable `projectName`, path hints, and task-scoped `mcpServers`; the Tasks composer has one compact configuration chip for project, keep-last-project, and MCP selection.
- Web `VibeCodingView` sends `projectName`, `projectDir`, and task-scoped `mcpServers`; MCP selection is a compact chip group in the existing Coding Agent rail.
- TV now has a focusable coding entrypoint for remote box, project, agent/model, MCPs, and write/speech input mode.
- The older dashboard page has a raw xterm terminal for OpenCode, and mobile Tasks has `XtermView`; `VibeCodingView` still streams groomed text only and does not request `rawSince`.
- Last-project memory is wired locally for mobile/web and inherited by car/watch task dispatch.
- Medici itself does have text-to-text tests and a production written-mode E2E test for `ai.tusrehber.com`, but Yaver does not yet expose a one-tap “select Medici and run this audit as a task” path.

## Evidence

### Medici Test Coverage

Medici repo: `/Users/kivanccakmak/Workspace/medici.ai`

Confirmed files:

- `eval_text/run.py`: cheap TUS text-to-text test bench through the real `api.run_turn(...)` pipeline, default runner `openrouter`.
- `eval_text/fixtures.py`: suite definitions consumed by the text bench.
- `text_to_text_evaluator.py`: larger structured text-to-text evaluator using DeepSeek via OpenRouter.
- `test_e2e_text.mjs`: Chromium E2E against `https://ai.tusrehber.com/` in mobile viewport, written mode, password flow, model switching, question/answer card, `/yaz`, `/ozet`.
- `deploy/manifest.txt`: states `web_tutor.py :8787` is the `ai.tusrehber.com` tutor service.

Conclusion: Medici has the requested text-to-text coverage shape. The Yaver task should be able to run commands such as:

```bash
cd /Users/kivanccakmak/Workspace/medici.ai
.venv-rt/bin/python eval_text/run.py --suite critical --runner openrouter
node test_e2e_text.mjs https://ai.tusrehber.com/ medici.1234
```

### Cloud Workspace 409 Screenshot

Screenshot body shows:

- HTTP 409
- `action:"cloud_workspace_required"`
- `activation.action:"provision_scheduled"`
- `pendingTaskId:"pending-cloud:..."`
- placement `lane:"cloud_standard"`, `resourceClass:"standard"`, `wakeRequired:true`

Current working tree evidence:

- `desktop/agent/task_fork.go`: `taskForkRequest.AllowLocalFallback`, `ProjectDir`, `MCPServers`.
- `desktop/agent/task_fork_test.go`: `TestHandleTaskForkAllowLocalFallbackRunsLocally`.
- `mobile/src/lib/quic.ts`: fork decodes `CloudWorkspaceRequiredError`.
- `web/lib/agent-client.ts`: fork decodes `CloudWorkspaceRequiredError`.
- `web/components/dashboard/VibeCodingView.tsx`: fork passes `allowLocalFallback:true`.

Status: mobile follow-up/fork call sites pass `allowLocalFallback:true` and carry project/MCP context.

### Project and MCP Selection

Current working tree evidence:

- `docs/architecture/TASK_MCP_PROJECT_SELECTION.md` describes the implemented contract.
- `desktop/agent/httpserver.go`, `tasks.go`, `task_fork.go`: agent accepts `projectDir` / `mcpServers` and threads them into task/fork options.
- `desktop/agent/runner_mcp_scope.go`: default empty MCP allowlist means no external MCPs; OpenCode gets `--pure` for empty allowlist.
- `desktop/agent/task_context.go`: brute-force auto project switch removed; explicit project prompts only.
- `mobile/src/lib/taskRequestBody.ts`: carries `projectName`, `projectDir`, and `mcpServers`.
- `mobile/app/(tabs)/tasks.tsx`: one task-configuration chip opens project / keep-last / MCP controls.
- `web/lib/agent-client.ts`: `createTask` and `forkTask` accept project hints and MCP allowlists.
- `web/components/dashboard/VibeCodingView.tsx`: project picker exists and task-MCP chips are wired into task/fork/pending dispatch.

Conclusion: backend and primary surface support is present; remaining proof is closed-loop surface verification.

### Remote OpenCode Stream

Current working tree evidence:

- `desktop/agent/tasks.go`: `emitRaw` stores raw stdout bytes with ANSI/TUI intact; `TERM=xterm-256color`, `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`.
- `desktop/agent/httpserver.go`: `/tasks/{id}/output?rawSince=` emits `raw_replay` and live `raw` frames.
- `mobile/src/lib/quic.ts`: `streamTaskOutput` supports `rawSince` and `onRaw`.
- `mobile/app/(tabs)/tasks.tsx`: OpenCode tasks have Chat/Terminal toggle and `XtermView`.
- `web/app/dashboard/page.tsx`: has `RawTaskTerminal` and passes raw frames to xterm.
- `web/components/dashboard/VibeCodingView.tsx`: direct `agentClient.streamTaskOutput` calls only consume groomed transcript and do not request `rawSince`.

Conclusion: mobile Tasks and the older dashboard can show OpenCode as a console. `VibeCodingView` cannot yet.

## Required Implementation

1. Add raw OpenCode terminal support to `VibeCodingView`, or refactor it to reuse the existing dashboard raw terminal pattern.
2. Closed-loop verify mobile RN-web and TV with a real device-context browser viewport / TV viewport against the runner box.
3. Run the canonical mobile deploy path only after the release checks pass.
5. Add tests that fail when:
   - mobile body drops `projectName` / `mcpServers`;
   - web create/fork body drops them;
   - empty MCP allowlist lets OpenCode see project/user MCP config;
   - VibeCodingView subscribes to an OpenCode task without `rawSince`;
   - mobile fork call sites do not send `allowLocalFallback:true`;
   - last-project memory auto-selects when enabled and can be cleared/disabled.

## Test Plan

Headless first:

```bash
cd /Users/kivanccakmak/Workspace/yaver.io
go test ./desktop/agent -run 'TaskFork|RunnerMCP|AutoSwitch|Placement|Privacy'
npm --prefix mobile run test -- taskRequestBody
npm --prefix web test -- taskStreamWithRecovery
```

Medici headless:

```bash
cd /Users/kivanccakmak/Workspace/medici.ai
.venv-rt/bin/python eval_text/run.py --suite critical --runner openrouter
node test_e2e_text.mjs https://ai.tusrehber.com/ medici.1234
```

Closed loop:

- Run the RN-web mobile app in Chrome with a real mobile context (`devices["iPhone 15 Pro"]`), not a resized desktop page.
- Open Tasks, select Medici, verify the picker shows Medici as selected.
- Select OpenCode and no MCPs; send a trivial “helo” task and verify it does not auto-import project MCPs or answer from an unrelated project.
- Select a known MCP explicitly; send a task and verify only that MCP plus `yaver` is available.
- Run a command that emits ANSI colors and `ls` output through OpenCode; verify mobile Terminal and web terminal render it as a stable console, not bulk newline text.
