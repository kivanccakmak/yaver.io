# Task Sync and Datacenter Findings — 2026-09-06

## Live Ubuntu evidence

- A local delete-all removed 18 stale tasks.
- One tmux session containing three real Codex panes became three distinct
  Yaver Tasks. Discovery reported `gpt-5.6-sol` and the `high`, `medium`, and
  `low` reasoning levels.
- Exiting one pane changed exactly its corresponding Task to `stopped`.
- A real OpenCode session reported `deepseek/deepseek-v4-flash`; reasoning was
  omitted because that runner did not provide it.

## Defects found and fixed

- `ListTasks` omitted `model`, `reasoning`, `goal`, and `deviceName` even
  though task detail contained them. The list contract now preserves that
  authoritative metadata.
- Convex task-snapshot publishing had reached `failCount: 177` with HTTP 404.
  The agent incorrectly sent an opaque Yaver bearer to the `.site`
  `/api/mutation` path, which does not exist there; the `.cloud` mutation API
  also rejects that bearer as Convex function auth.
- The fix is a first-class authenticated `POST /task-snapshots` route. It
  validates the Yaver session, enforces owned-device writes, and stores one
  bounded prompt-free snapshot per device.

## Privacy and cost contract

Convex receives only `deviceId`, `observedAt`, and at most 200 lifecycle
entries. Each entry contains `taskId`, optional `yaverSessionId`, `status`,
optional closed-enum `hostKind`, and `updatedAt`. Convex receives no prompts,
output, source, paths, project, title, runner, model, or reasoning.

The local agent remains authoritative. Lifecycle changes publish
event-driven snapshots, with a two-hour freshness floor. An idle coordinator
does not write merely to renew its role.

## Datacenter alignment

This work matches `docs/architecture/YAVER_DATACENTER.md` from `origin/main`:

- Task identity is device-scoped and can be composed by `FabricConnection`.
- Any surface may attach through an owned device.
- A worker continues locally without Convex; Convex is discovery and fallback,
  not execution.
- A thin Mac may remain the controller while Linux performs build, test, or
  browser work.
- Gateway retries must retain one task identity and must not duplicate the
  task.

## Remaining gaps

- The Datacenter `WorkloadSpec`, `Job`, `Attempt`, lease/fencing, and
  source/artifact protocols are not implemented by this patch.
- Multi-node failover and idempotency remain open.
- RN-web pixel/browser proof and bulk delete are still pending in this
  session.
- Release and deployment remain pending.

These findings are foundational evidence for **DC-004**, **DC-600**,
**DC-1107**, and **DC-1110**. They do not complete those backlog items.
