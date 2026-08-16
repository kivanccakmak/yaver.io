# Task Project Selection And Task-Scoped MCPs

Status: implemented across Go agent, mobile Tasks, web VibeCoding, car/watch inherited dispatch, and TV coding entrypoint (2026-08-08).

## Contract

Task creation carries portable project identity and an explicit MCP allowlist:

```json
{
  "projectName": "medici.ai",
  "workDir": "/home/yaver/workspaces/medici.ai",
  "projectDir": "/home/yaver/workspaces/medici.ai",
  "mcpServers": ["tusrehber"]
}
```

`projectName` is the durable selector. `workDir` / `projectDir` are local hints only and must never ride Convex. This matters for the Mac UI -> Hetzner Ubuntu runner case: `/Users/.../medici.ai` is not executable on Ubuntu, so the runner resolves `projectName` against its own discovered projects.

Empty or absent `mcpServers` means no external MCP servers for that task. The runner still gets Yaver's own MCP doorway.

## Agent Behavior

- `effectiveTaskWorkDir` prefers a scannable local `workDir`, then resolves `projectName` / path basename against the runner machine's `PROJECTS.md`.
- `armedSystemFrame` includes a selected-project frame so the runner sees which project is pinned and which directory it is running in.
- `autoSwitchProject` is gated to explicit project intent and no longer brute-force matches every prompt word. A bare greeting must not select a project.
- `prepareRunnerMCPScope` receives the task allowlist. OpenCode uses `--pure` when the allowlist is empty so project/global MCP config cannot leak into a greeting task.
- Forks carry `allowLocalFallback`, optional `projectDir`, and task MCP context; if a fork omits MCPs, it inherits the parent's allowlist.

## Surface Behavior

- Mobile Tasks has one compact task-configuration chip. The sheet behind it manages project, keep-last-project, and task MCPs without adding permanent UI rows.
- Web VibeCoding keeps project selection in the existing Projects rail and adds compact task-MCP chips inside the Coding Agent rail.
- TV has a focusable coding screen for remote box, project, agent/model, MCPs, and write/speech input mode. This supports the Ubuntu 4 GB + OpenCode + DeepSeek V4 Flash + Medici use case from tvOS.
- Car and watch do not expose dense pickers. They inherit the last selected project for the runner device and dispatch with the same portable `projectName` / local `workDir` fields.

## Privacy

Convex placement and dispatch metadata may carry only `projectSlug` / project name style identifiers. Absolute paths (`workDir`, `projectDir`, `path`) and prompts remain local/P2P. The generic Convex privacy tripwire forbids `projectDir` in mutation payloads.

## Tests

Relevant guards:

- Go: project resolution on runner machine, auto-switch gating, selected-project prompt frame, task MCP scope, fork fallback/context, Convex privacy.
- Mobile: task body serialization, keep-last-project storage, pending Cloud Workspace replay with prompt-free metadata.
- Web: task body serialization for project identity and MCP allowlist.
