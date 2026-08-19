# Yaver macOS GUI / Desktop App Audit — Deep Pass 2

Date: 2026-08-19  
Scope: security and execution-path review after the first GUI audit. This pass
focuses on concrete startup, authentication, IPC, preview, routing, packaging,
and test evidence. tvOS source and build artifacts are explicitly out of scope.

## Bottom line

The newer `electron` client has the right security direction and is the path to
keep: sandboxed renderer, context isolation, navigation policy, scoped auth
interception, bounded logs, and direct-versus-MAS capability separation.

The older `desktop/app` client remains materially unsafe and operationally
opaque. It exposes bearer tokens and broad authenticated operations to renderer
JavaScript, accepts arbitrary local OAuth callback tokens, allows arbitrary
external URLs, and can fail before `ready-to-show` without showing a cause.

The two packages must not remain co-equal production clients. The highest-value
work is to retire `desktop/app`, finish the current Electron packaged smoke
lane, and ship the renderer recovery code in the installed distributions.

## What this pass verified

- Inspected `desktop/app/src/main/main.js` and `preload.js`, including startup,
  OAuth, HTTP proxy, device routing, IPC, and persistence.
- Inspected `desktop/app/src/renderer/index.html` and `webview-preload.js` for
  preview and error behavior.
- Inspected `electron/src/main.js`, `agent-manager.js`,
  `navigation-policy.js`, and the agent fetcher against package/release wiring.
- Current Electron unit suite remains green: 47 tests passed.
- Installed app identities were previously verified from `Info.plist`:
  `io.yaver.gui` 0.1.0 and `io.yaver.mobile` 0.1.3.

## Deep findings

### DP1 — Legacy renderer receives bearer tokens directly

Severity: High

Evidence:

- `desktop/app/src/main/preload.js:10-12` exposes `getAuthState()`.
- `desktop/app/src/main/main.js:378-385` returns `{ token: authToken }` to the
  renderer.
- `desktop/app/src/renderer/index.html` reads that token to open authenticated
  SSE streams around lines 1253-1362.

The renderer must possess the token for the current implementation, but this
means any renderer XSS, compromised preview bridge, or accidental log/DOM
exposure can extract the account bearer. The newer Electron client correctly
keeps auth material in the main process and injects it only at the network
boundary.

Remediation:

- Move SSE/raw-output streaming behind a main-process IPC method that returns
  events, not credentials.
- Remove `token` from renderer-visible auth state.
- Add a regression test asserting no preload API returns a bearer value.

### DP2 — Legacy OAuth callback has no state/nonce binding

Severity: High

Evidence: `desktop/app/src/main/main.js:222-261` starts a server on
`127.0.0.1:19836`, accepts any request containing `?token=...`, stores that
token, and resolves the pending auth promise. It does not issue or validate a
cryptographically random state value, bind the callback to the provider, or
require a method/expected callback shape.

Impact: while the callback listener is open, another local process can submit a
bearer token and make the app adopt it. Localhost is not an authentication
boundary between processes.

Remediation:

- Generate a high-entropy one-time state before opening the provider.
- Include state in the provider request and require exact state on callback.
- Accept only the expected callback method and consume the state once.
- Prefer an OS-registered custom protocol or PKCE-capable flow where supported;
  never put a long-lived token in a URL if a one-time code can be exchanged by
  the main process.

### DP3 — Generic IPC permits arbitrary authenticated API actions

Severity: High

Evidence: `desktop/app/src/main/preload.js:28-29` exposes generic
`agentRequest(method, path, body)` and `convexRequest(method, path, body)`.
`desktop/app/src/main/main.js:417-420` and `475-482` forward those values with
the current bearer token. The renderer also receives destructive convenience
methods such as account deletion, agent shutdown/clean, and sandbox config.

Impact: an injection in the main UI or preview integration is not limited to
the visible action set; it can call any authenticated route reachable by the
main process. This also makes route authorization and auditability difficult.

Remediation:

- Replace generic methods with an allowlisted operation table containing method,
  path template, input schema, and capability.
- Keep destructive operations explicit and require typed confirmation generated
  by the main process.
- Log operation name and outcome, never request bodies containing secrets.
- Add tests for path traversal, query injection, unsupported methods, and
  cross-device route substitution.

### DP4 — `open-external` accepts arbitrary renderer-controlled URLs

Severity: Medium/High

Evidence: `desktop/app/src/main/preload.js:96` exposes `openExternal(url)` and
`desktop/app/src/main/main.js:490-491` calls `shell.openExternal(url)` without
scheme or host validation.

The current renderer mostly passes known links, but the boundary itself is
unrestricted. A renderer compromise can launch `file:`, custom schemes, or
other handlers installed on the Mac.

Remediation: accept only `https:` links, optionally limited to an explicit host
set for in-product links; add tests for `file:`, `javascript:`, custom schemes,
embedded credentials, and malformed URLs.

### DP5 — Desktop token file permissions are not deterministic

Severity: Medium/High

Evidence:

- `desktop/app/src/main/main.js:38-47` creates the config directory with
  explicit `0700` only in `saveConfig()`.
- `saveDesktopSettings()` at lines 78-80 calls `mkdirSync(..., { recursive:
  true })` and `writeFileSync()` without an explicit mode.
- `desktop-settings.json` stores `authToken` at lines 71-76 and 237-239.

Impact: new file mode depends on the process umask and the existing file mode
is preserved. The security contract is implicit.

Remediation: create the directory with `0700`, create the file with `0600`,
then verify/chmod the existing path before use. Add a startup check that emits a
named repair route if permissions are too broad. Prefer protected storage where
the distribution permits it.

### DP6 — Legacy device URL construction is an SSRF/tenant boundary

Severity: Medium/High

Evidence: `desktop/app/src/main/main.js:319-350` constructs an HTTP URL from
`device.quicHost`, `device.quicPort`, and relay metadata, then performs
authenticated fetches from the privileged main process. There is no local
allowlist or explicit host/port validation in this function.

Impact: metadata corruption or an incorrect relay row could direct bearer-
bearing requests to an unintended endpoint.

Remediation:

- Validate scheme, hostname/IP form, port range, and relay URL origin.
- Reject userinfo, non-HTTP schemes, and ambiguous host encodings.
- Require an access-graph/device-ID match before proxying.
- Add tests for loopback, link-local, private ranges, IPv6 forms, redirects,
  and a malicious device row.

### DP7 — Startup still has a silent no-window path in `desktop/app`

Severity: High

Evidence: `desktop/app/src/main/main.js:100-121` creates the window hidden,
calls `mainWindow.loadFile(...)` without awaiting/catching it, and shows only
on `ready-to-show`. There are no `did-fail-load`, `render-process-gone`,
`unresponsive`, or uncaught-load recovery handlers in this implementation.

Impact: the black-screen symptom can recur if the HTML file is present, the
preload fails, Chromium crashes, or a local resource is denied.

Remediation: make startup a state machine: creating → loading → ready →
recoverable-failure. Always expose a visible local recovery page with error
code, retry, open logs, and browser fallback. Add a timeout so missing
`ready-to-show` cannot leave a hidden process indefinitely.

### DP8 — Preview trust boundary is not tested end-to-end

Severity: Medium

Evidence:

- `desktop/app/src/main/main.js:116` enables `webviewTag`.
- `desktop/app/src/renderer/index.html:4` permits wildcard frame/connect/image
  sources; line 267 enables preview popups.
- No packaged test was found proving preview-origin scripts cannot access the
  privileged `window.yaver` bridge or navigate the main window.

Remediation: create a malicious preview fixture that attempts bridge access,
parent navigation, popup creation, custom-scheme navigation, credential access,
and postMessage abuse. Run it in a packaged macOS app and assert each action is
blocked or explicitly mediated.

### DP9 — Current Electron recovery is source-tested but not artifact-proven

Severity: Medium

Evidence:

- `electron/src/main.js` now contains bounded renderer retry and a local
  recovery page.
- `electron/test/main-wiring.test.js` checks source wiring, not a real
  BrowserWindow failure.
- `e2e/electron-desktop-smoke.mjs` requires
  `electron/node_modules/electron/dist` and a runnable agent; this Mac lacked a
  usable local Electron runtime during the attempted smoke and had critically
  low disk space.

Remediation: add a deterministic `GUI_FAILURE_FIXTURE=1` mode that loads a
local fixture and intentionally triggers failed navigation/renderer failure.
Assert recovery-page text and retry behavior in the packaged app. Keep live
network/agent smoke separate.

### DP10 — Agent packaging has a network-dependent prerequisite but no local
failure contract

Severity: Medium

Evidence:

- `electron/package.json` packages `resources/bin` as `extraResources`.
- `electron/scripts/fetch-agent-binary.mjs` downloads a release asset and
  checksum over GitHub before packaging.
- The source tree does not contain `electron/resources/bin/yaver` by default.

Remediation: add a preflight command that reports platform/arch, agent version,
exact missing path, download command, and whether the build is client-only or
direct-node. `npm run pack` should fail immediately with that message instead
of failing later inside electron-builder.

## Positive controls confirmed

- Current Electron renderer uses sandboxing, context isolation, and disabled
  Node integration in `electron/src/main.js:486-516`.
- Current Electron navigation policy is extracted and unit-tested.
- Current auth interceptor strips token/relay query parameters before adding
  headers and has dedicated tests.
- Current direct agent manager adopts a healthy agent and only stops children
  it spawned.
- Current direct/MAS distinction is encoded in build configuration and tested
  in `electron/test/mas-config.test.js`.
- Current desktop logs are bounded and exposed through tray/preload paths.

## Completion matrix

| Area | Implemented | Correctness proven | Production-ready |
|---|---:|---:|---:|
| Current Electron navigation boundary | Yes | Unit tests | Mostly; needs packaged smoke |
| Current Electron auth URL interception | Yes | Unit tests | Yes, pending artifact verification |
| Current renderer black-screen recovery | Source yes | Static tests only | No, not shipped/proven in artifact |
| Legacy renderer startup recovery | No | No | No |
| Legacy IPC least privilege | No | No | No |
| Legacy OAuth state binding | No | No | No |
| Legacy token storage permissions | Partial | No | No |
| MAS client-only boundary | Yes | Unit/config tests | Release-gate dependent |
| Direct embedded-agent packaging | CI path | CI config only here | Needs local preflight/artifact proof |
| Preview isolation test | No | No | No |

## Recommended implementation sequence

1. Freeze `desktop/app` as unsupported or remove it from release/install paths.
2. Add OAuth state/PKCE and protected auth storage only if legacy code must live.
3. Remove renderer-visible bearer tokens and generic IPC from any supported GUI.
4. Add packaged fixture smoke tests for first paint, black-screen recovery, and
   malicious preview isolation.
5. Add packaging preflight and deterministic local direct/client-only modes.
6. Publish a single app identity/version map and make the About/diagnostics
   surface show it.

## Final assessment

The current Electron architecture is salvageable and substantially closer to a
safe production desktop client. The legacy `desktop/app` implementation is not
safe to keep as a second production path without a security rewrite. The most
important unresolved product defect is not whether the dashboard can eventually
render; it is that a renderer/load failure can still be presented as a blank
window in installed versions and is not yet covered by a real packaged pixel
smoke.
