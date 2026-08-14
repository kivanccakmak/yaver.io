# Self-hosted cloud worker contract

A cloud worker is the normal Yaver agent deployed on a trusted Linux VM or
container. It is not a new proxy layer: it runs `codex` and `opencode` directly
through the same per-task runner interface as a paired desktop.

## Required controls

- Launch one fresh workspace/worktree per task; remove it after the retention
  window.
- Use `codex exec --json --sandbox workspace-write` for Codex tasks.
- Store provider and Git credentials in the worker's secret store only. Never
  put them in Convex, task metadata, logs, or a repository checkout.
- Permit outbound Git writes only to `yaver/*` review branches. Create a pull
  request through the provider API after the user approves it.
- Report only `taskRuns` metadata to Convex: runtime, status, runner, model,
  reasoning effort, Git ref, and commit SHA. Prompts, files, tool output, and
  model output remain on the worker.

## Routing

Clients select a runtime in this order:

1. A connected private Yaver agent.
2. Phone-local Yaver workspace for file/Git-only tasks.
3. An explicitly configured self-hosted cloud worker.
4. A local queued task when no executable runtime is available.

The worker must be registered as a normal Yaver device. This preserves the
authenticated P2P/relay transport and avoids adding a separate public task API.
