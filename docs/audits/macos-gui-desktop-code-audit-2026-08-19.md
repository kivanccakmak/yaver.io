# Yaver macOS GUI / Desktop App Code Audit

Date: 2026-08-19  
Scope: `desktop/app`, `electron`, macOS packaging/release wiring, and the real
installed GUI identities observed on this Mac.  This audit is read-only; it
does not include tvOS code or tvOS build artifacts.

## Executive summary

The repository contains two materially different Electron desktop clients:

| Surface | Source | Bundle identity | Version in source | Role |
|---|---|---|---:|---|
| Legacy desktop client | `desktop/app` | `io.yaver.desktop` | `1.0.0` | Locally-rendered hand-built dashboard with direct IPC proxy |
| Current desktop GUI | `electron` | `io.yaver.gui` | `0.1.3` | Hardened shell around the real web dashboard; direct builds supervise the Go agent |
| Mac App Store/TestFlight client | `electron` + `electron-builder.mas.cjs` | `io.yaver.mobile` | `0.1.3` | Sandboxed network client; no local agent |

The installed `/Applications/Yaver.app` reported `io.yaver.gui`, version
`0.1.0`. The installed `/Applications/Yaver 2.app` reported
`io.yaver.mobile`, version `0.1.3`. They are therefore different distributions
and neither identifies itself as the legacy `io.yaver.desktop` package.

The observed black screen is a shipped failure-mode defect, not a dashboard
availability problem. The installed GUI logged a renderer crash followed by
`ERR_FAILED` while loading `https://yaver.io/dashboard`; the web endpoint itself
returned HTTP 200. The older/current binaries did not expose a useful recovery
surface. The working-tree `electron` source now contains a recovery screen and
one retry, but that fix has not been packaged into the installed binary.

## What is implemented

### Current `electron` GUI

- Loads the production dashboard or a development server through
  `resolveDashboardUrl()` (`electron/src/main.js`).
- Uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and
  a navigation allowlist (`electron/src/main.js`, `electron/src/navigation-policy.js`).
- Keeps auth material process-scoped and strips agent/relay credentials from
  stream URLs before injecting headers (`electron/src/auth-interceptor.js`).
- Supports a direct-build embedded Go agent through `AgentManager`; MAS builds
  intentionally remain client-only (`electron/src/agent-manager.js`,
  `electron/electron-builder.mas.cjs`).
- Provides tray controls, deep links, task notifications, diagnostic logs,
  launch-at-login, keep-awake, and architecture-aware direct update handling.
- Has unit coverage for navigation, auth interception, agent lifecycle,
  logging, runtime policy, MAS packaging, and main-process wiring.
- The current working-tree change adds renderer-load/crash recovery and fixes a
  tray `Invalid URL` path (`electron/src/main.js`).

### Legacy `desktop/app` client

- Has a broad dashboard surface: auth, devices, agent proxy, tasks, projects,
  previews, health, quality gates, settings, sandbox, and local-agent probing.
- Uses a preload bridge rather than enabling renderer Node integration.
- Supports direct and relay device connection, OAuth callback handling, email
  auth, TOTP, and desktop settings persistence.
- Includes a preview `webview`, raw task output polling/SSE handling, and basic
  tray behavior.

### Release/test wiring

- `electron/test/*.test.js` provides a bounded local suite.
- `e2e/electron-desktop-smoke.mjs` is intended to launch Electron itself,
  inspect the trusted preload bridge, verify the embedded agent, and optionally
  drive a real dashboard task.
- `.github/workflows/release-gui.yml` builds macOS arm64/x64, Windows, and
  Linux artifacts; macOS release jobs verify codesigning, Gatekeeper, stapling,
  and the embedded agent binary.
- MAS configuration explicitly excludes `Resources/bin/yaver` and sets the
  client-only bundle ID `io.yaver.mobile`.

## Findings

### P0 — Installed GUI can show a permanent black window

Evidence:

- The installed app log recorded `renderer_process_gone` with exit code 5 and
  then `ERR_FAILED (-2) loading 'https://yaver.io/dashboard'`.
- The current source previously registered only logging for
  `did-fail-load`/`render-process-gone`; it did not show the window with a
  recovery route. The working-tree fix now adds `showRendererFailure()` and a
  bounded retry, but the installed `0.1.0` binary predates it.
- The legacy client uses `show: false`, calls `loadFile()` without awaiting or
  catching it, and only calls `show()` from `ready-to-show`:
  `desktop/app/src/main/main.js:100-123`. A renderer/load failure can therefore
  leave the user with an invisible or black surface and no named cause.

Impact: users cannot distinguish a crashed renderer, failed network load,
stale binary, or hidden tray window. This violates the product failure contract.

Required fix:

1. Ship the current renderer recovery behavior in the signed direct and MAS
   clients.
2. Add the same failure contract to `desktop/app` or retire that package.
3. Add a real packaged smoke assertion: first paint, non-black meaningful DOM,
   renderer crash recovery, failed-load recovery, and app-version identity.

### P0 — Desktop implementation and distribution identity drift

Evidence:

- `desktop/app/package.json` declares `io.yaver.desktop` and version `1.0.0`.
- `electron/package.json` declares `io.yaver.gui` and version `0.1.3`.
- `electron/electron-builder.mas.cjs` changes the bundle to `io.yaver.mobile`.
- The repository’s canonical `versions.json` contains `gui: 0.1.3`, but the
  installed direct GUI was `0.1.0`.

Impact: a user can install a valid-looking Yaver app that runs a different
architecture, receives a different update channel, and lacks fixes present in
the current source. Support/debugging cannot reliably map a visible app to a
source package.

Required fix: choose one desktop implementation, make the other a clearly
named archived package or delete it, and add a release gate that checks bundle
ID, `CFBundleShortVersionString`, `versions.json`, package version, and source
commit/build metadata.

### P1 — Legacy client exposes excessive privileged IPC

Evidence: `desktop/app/src/main/preload.js` exposes:

- `get-config` and `save-config`;
- arbitrary `agent-request(method, path, body)`;
- arbitrary `convex-request(method, path, body)`;
- arbitrary `open-external(url)`;
- destructive methods including account deletion, machine removal through the
  agent, agent shutdown/clean, and sandbox configuration.

The renderer is local and trusted in the intended design, but the client also
enables `webviewTag`, loads arbitrary preview content, and uses a permissive
renderer CSP (`connect-src *`, `frame-src *`). A renderer compromise or
unexpected HTML injection would have a large privileged API surface.

Required fix: replace generic IPC with narrow typed operations, never return
the full config/token to renderer code, validate external URLs against an
explicit `https:`/approved-host policy, and isolate preview content from the
main renderer. The newer `electron` bridge is materially better and should be
the only supported path.

### P1 — Legacy client can persist secrets with non-explicit permissions

Evidence: `desktop/app/src/main/main.js:78-80` writes
`desktop-settings.json` without a file mode and creates the directory without
an explicit mode. `config.json` is written with `0600`, but the separate
desktop token file is not guaranteed owner-only under all existing-file and
umask conditions.

Required fix: use an owner-only directory and file mode (`0700`/`0600`), verify
permissions after creation, and prefer Electron/macOS protected storage for
desktop auth material. Add a test that starts from absent settings and checks
the resulting mode.

### P1 — Legacy preview isolation is too permissive

Evidence:

- `desktop/app/src/main/main.js:116` enables `webviewTag` without sandbox or a
  partition policy.
- `desktop/app/src/renderer/index.html:4` permits `connect-src *`, `img-src *`,
  and `frame-src *`.
- The preview webview has `allowpopups` at
  `desktop/app/src/renderer/index.html:267`.

Impact: preview projects need broad capability, but the current boundary makes
it difficult to prove that preview content cannot influence the privileged
desktop renderer or open arbitrary application surfaces.

Required fix: use the current Electron shell’s remote dashboard model or put
previews in a separately partitioned, sandboxed BrowserView/webview with an
explicit URL policy, no popups by default, and tested postMessage boundaries.

### P1 — Broad silent catches hide operational failures in the legacy UI

Evidence: `desktop/app/src/renderer/index.html` contains many `catch {}` blocks
around auth, devices, tasks, runner status, dev-server state, health, quality,
and SSE paths, including the polling loop around lines 682-703 and runner/
device setup paths around lines 745-814.

Impact: a user sees empty lists, stale state, or a spinner rather than a named
cause and route-to-fix. This is exactly the false-green/silent-failure class
the product architecture is intended to prevent.

Required fix: normalize failures into structured codes, render the cause on
the active surface, and provide an invocable remediation route. Empty state
must distinguish “no data” from “request failed”.

### P1 — Current direct package depends on a generated agent resource

Evidence: `electron/package.json` declares `extraResources.from:
resources/bin`, while the repository checkout has no tracked
`electron/resources/bin/yaver`. `.github/workflows/release-gui.yml` runs
`scripts/fetch-agent-binary.mjs` before packaging.

Impact: a local `npm run pack` from a fresh checkout is not equivalent to the
release build; it can produce a client without the embedded agent or fail
during packaging. The local GUI test path also expects a downloaded Electron
runtime under `electron/node_modules/electron/dist`.

Required fix: make `npm run pack` fail early with a named prerequisite message,
or provide a documented local build target that explicitly packages the
current local signed agent. The smoke test should assert the exact binary
exists before launching a direct-node build.

### P1 — Packaged smoke coverage is not a mandatory local/release invariant

Evidence:

- Electron unit tests are source/static wiring tests and do not create a real
  packaged macOS window.
- `e2e/electron-desktop-smoke.mjs` assumes a downloaded Electron binary under
  `electron/node_modules/electron/dist` and an available embedded agent.
- No test in the inspected GUI suites asserted that a packaged app paints a
  visible non-black surface after renderer failure.

Required fix: add a deterministic fixture mode that uses a local static
dashboard/error page and a stub agent, then run it against the packaged `.app`
on macOS. Keep network/auth/task smoke as a separate opt-in lane.

### P2 — Legacy device routing trusts remote device URL fields

Evidence: `desktop/app/src/main/main.js:320-350` constructs direct URLs from
`device.quicHost` and `device.quicPort`, then constructs relay URLs from remote
settings. The source does not show an explicit host/port policy before the main
process performs authenticated fetches.

Impact: authenticated main-process requests can be redirected to an unintended
host if device/relay metadata is compromised or malformed.

Required fix: validate schemes, ports, host formats, and ownership/access-graph
identity before fetch; reject loopback/private targets unless the device is
explicitly the local node; add SSRF and tenant-isolation tests.

### P2 — Legacy network/API error semantics are flattened

Evidence: `agentRequest()` returns parsed JSON or `{ ok, status, body }`, while
many renderer callers only inspect truthiness or catch and suppress errors.
`convexRequest()` returns `res.json()` without preserving HTTP status or a
structured failure code.

Impact: HTTP failure, auth expiry, agent unreachability, and valid empty data
can be rendered the same way.

Required fix: share the structured failure schema used by the Go agent and
newer web/mobile clients; preserve status, stable code, remedy, and route.

### P2 — Direct GUI and MAS GUI capabilities are easy to confuse

The MAS build is intentionally client-only, while the direct build is a local
node. The app UI and package naming should make this distinction unavoidable:
“This Mac is a Yaver node” versus “Client-only: connect to a Yaver node”. The
current source has status fields for this in `electron/src/main.js`, but the
installed apps and old package identities make the distinction unclear.

Required fix: show distribution, app version, local-agent capability, and
exact diagnostic-log path in an About/Health surface and include them in the
first-run error screen.

## Implemented but not proven in this audit

- Current Electron renderer recovery source logic: unit/static tests pass, but
  a fresh signed packaged app could not be run on this Mac because the machine
  was critically low on disk and the local Electron runtime hit a V8 virtual
  memory error.
- Direct embedded-agent startup and the full task lifecycle: covered by the
  Playwright smoke harness and CI wiring, but not re-run here.
- macOS signing/notarization and MAS provisioning: represented in CI/release
  scripts, not exercised here; no TestFlight or deployment action was taken.
- Cross-surface parity with web/mobile/tvOS/watchOS: not proven by the desktop
  unit suite. Desktop consumes the web dashboard in the current architecture,
  but native transport/auth behavior still needs a dedicated matrix.

## Recommended order

1. Consolidate desktop implementations and identity/version mapping.
2. Ship renderer crash/load recovery to both supported macOS distributions.
3. Add a packaged macOS smoke lane that proves visible first paint and failure
   recovery with a deterministic stub.
4. Retire or harden `desktop/app`; do not keep two privileged Electron clients
   with different security models.
5. Replace generic legacy IPC/config exposure and permissive preview isolation.
6. Convert silent catches and flattened errors into structured UI failure routes.
7. Add direct-build prerequisites and agent-resource checks before packaging.

## Verification performed

- Inspected repository source rather than relying on handoff documentation.
- Confirmed current `electron` tests: 47 passing, 0 failing.
- Confirmed dashboard HTTP reachability: `https://yaver.io/dashboard` returned
  HTTP 200.
- Confirmed installed app identities and versions from their `Info.plist`.
- Reproduced the visible black-window behavior on the installed GUI.
- Preserved unrelated worktree changes; no commit, push, deployment, or tvOS
  mutation was performed.
