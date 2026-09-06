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

## Cross-surface Datacenter verification roadmap

The Go agent owns the authoritative local Task lifecycle. Convex carries only
the bounded prompt-free roaming snapshot described above. Every surface
consumes the same Task identity and lifecycle contract; no client recreates a
parallel tmux-session or coding-agent-session model.

Verification is layered and ordered:

1. CLI/MCP and direct agent HTTP probes prove discovery, create, reattach,
   continue, reconcile, stop, and delete without a UI.
2. Browser automation is the first closed-loop gate because it is the lightest
   real surface available on an Ubuntu worker.
3. Android native surfaces follow on Ubuntu through Redroid or an emulator.
4. Apple-only native surfaces require an Xcode-capable macOS worker. Linux
   contract tests may validate their shared schema, but must never be reported
   as tvOS, watchOS, CarPlay, iOS, or visionOS UI proof.

| Surface | Required closed-loop evidence | Status |
|---|---|---|
| Go agent + CLI/MCP | Multiple runner panes become distinct Tasks; create/continue/reattach/reconcile/stop/delete converge locally and in Convex | Headless lifecycle proven; keep as a regression gate |
| Web | Real Chromium, named selectors and pixels; Task counts/statuses update without a reload-only false green | Pending |
| RN phone/tablet | Real RN-web with a full named mobile/tablet device descriptor; no resized-desktop substitute; refresh and scoped bulk delete | Pending |
| Electron/desktop GUI | Real Electron or supported desktop harness; attach to the same Task and preserve its conversation/lifecycle | Pending |
| Android phone/tablet | Redroid/emulator UI automation after the browser gate; same Task and bulk-action contract | Pending |
| Android TV | Emulator/Redroid-compatible TV UI test for concise Task status, continue, stop, and recovery | Pending |
| Wear OS | Emulator test for one Task/status and one safe action, backed by the same server contract | Pending |
| Android Auto | Automotive emulator or host test for voice-safe Task continuation and stop; no dense session inventory | Pending |
| iOS/iPadOS | Xcode simulator/device test on a macOS worker after shared RN and server gates pass | Pending macOS gate |
| tvOS | Xcode tvOS simulator test for concise Task status/action parity | Pending macOS gate |
| watchOS | Xcode watch simulator test for one Task/status and one safe action | Pending macOS gate |
| CarPlay | Xcode CarPlay simulator test for voice-safe continuation and stop | Pending macOS gate |
| visionOS / glass / AR-VR | Xcode visionOS or the platform's real spatial harness; preserve Task identity and quiet status in space | Pending platform gate |

Every applicable row covers:

- discovery of Codex and OpenCode work as ordinary Yaver Tasks;
- model/reasoning metadata from the local agent where the runner exposes it;
- start on one surface and reattach/continue from another without duplication;
- refresh or scroll-triggered reconciliation after a local runner exits;
- explicit stop/delete and scoped select-all without stale Convex rows;
- offline behavior where the local Task continues while Convex is unavailable;
- prompt-free payload and two-hour idle write-volume assertions;
- one visible blocking cause and route to fix instead of an indefinite spinner.

### Transport parity

- Browser and RN-web use authenticated HTTP for requests and SSE for streams.
  They do not gain raw QUIC, weaker CORS, or tokens in URLs.
- Native clients may use LAN, relay, or QUIC where the platform supports it.
  A QUIC extension is added only after an observed capability gap.
- HTTP/SSE and native transport implementations share the same Task endpoints,
  status enums, reconnect cursors, stop/delete semantics, and auth boundary.
- Any separate platform transport implementation requires a parity test for
  reconnect, refresh, stop/delete, and stale-session reconciliation.

### Ubuntu execution profile

The Ubuntu worker performs source changes, Go/backend checks, RN-web serving,
Chromium/Playwright, and Android Redroid/emulator tests. Work is sequential:
one build, server, browser, or emulator phase at a time. Browser automation is
the first priority; Redroid starts only after the browser lane is green and
resource headroom has been measured. Native Apple verification is scheduled
onto an owned macOS capability when required rather than consuming the thin
client or being simulated dishonestly on Linux.

## Remaining gaps

- The Datacenter `WorkloadSpec`, `Job`, `Attempt`, lease/fencing, and
  source/artifact protocols are not implemented by this patch.
- Multi-node failover and idempotency remain open.
- RN-web pixel/browser proof and bulk delete are still pending in this
  session.
- Release and deployment remain pending.

These findings are foundational evidence for **DC-004**, **DC-600**,
**DC-1107**, and **DC-1110**. They do not complete those backlog items.
