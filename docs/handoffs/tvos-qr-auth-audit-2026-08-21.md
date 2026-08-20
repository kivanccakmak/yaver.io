# tvOS QR Auth Audit — 2026-08-21

## Scope

This handoff records the state of the iPhone-approved QR sign-in flow for the
tvOS simulator, the difference between account authentication and downstream
agent authorization, the simulator-signing caveat discovered during testing,
and the UI changes currently in the working tree.

Code is the source of truth. Re-check every route and symbol named here before
acting on this document.

## User-visible result

The phone-to-TV device-code exchange works:

1. tvOS creates a device code and displays its QR code.
2. An already-authenticated iPhone scans the QR from mobile Settings.
3. The phone authorizes the code using its existing Yaver account session.
4. tvOS claims a TV-scoped session and enters the authenticated dashboard.

The flow is intentionally independent of how the phone originally signed in.
Apple, Google, GitHub, GitLab, Microsoft 365, and email/password all converge on
the phone's Yaver session before it approves the TV.

What failed was the next layer: after entering the dashboard, Tasks/Vibing and
render operations did not work. Therefore the observed incident is not evidence
that the upstream OAuth provider exchange failed. It is a post-login
authorization or transport failure.

## Working

- Mobile can scan the tvOS QR code.
- Mobile approval succeeds and shows "Machine signed in."
- tvOS receives a token and switches from Sign In to Dashboard.
- The account backend can return the user's machine registry to tvOS.
- **The TV-scoped token reaches the box and reads:** simulator run against
  ubuntu-4gb-hel1-1 got `GET /tasks` → 200 (task list), `GET /dev/status`,
  `GET /info`, `GET /agent/status`, `GET /agent/runners`, `GET /projects` all
  → 200 through the relay with the TV-scoped bearer.
- Email/password remains the second, independent tvOS login option — verified
  working on the REAL device today (2026-08-21); it mints a full-owner session
  the scope gate does not restrict.
- Current source has a companion-session allowlist in
  `desktop/agent/httpserver.go` and emits the stable
  `auth.session.scope_denied` reason code for a TV-scope refusal.
- Several tvOS views already recognize that reason and route to
  `UpdateAgentView`.

## Broken or incomplete

- The exact 403 producer from the failed live run has not yet been captured
  with a normally signed simulator build. The two post-login boundaries are:
  - the relay rejecting its connection credential; or
  - the agent rejecting the TV-scoped session for the requested route.
- **RESOLVED root cause (2026-08-21, simulator run against ubuntu-4gb-hel1-1):**
  the refusal is the AGENT, not the relay. The TV list loads (`GET /tasks` →
  200), but creating a session fails: `POST /tasks` → 403 with the exact
  115-byte `companionScopeDenied` body (`code: auth.session.scope_denied`,
  `scope: tv`). The box runs `yaver 1.99.411` = **npm latest**, but the
  allowlist clause that permits TV-scope `POST /tasks`
  (`tvTaskMutationAllowed`, `desktop/agent/httpserver.go`, commit `6a70b7e3f`
  "feat: add phone-approved TV login", 2026-08-20) is **unreleased** — no git
  tag contains it. So the deployed agent predates the allowlist fix; the route
  is a NEW AGENT RELEASE (then box update), not a client bug.
  Email/password sign-in works today on the real device because it mints a
  full-owner session that the scope gate does not restrict; only the QR path
  mints the TV-scoped companion token that the stale allowlist still denies.
  The QR path was never tested on the real device.
- ~~`RemoteRuntimeWebRTCView` reduces its error to a plain string. It loses the
  structured reason code and always offers `Retry render` and `Fix with AI`.~~
  **FIXED (2026-08-21):** the code travels through
  `TVRemoteRuntimeController.errorCode`, and a `auth.session.scope_denied`
  verdict renders the Update Agent card instead of Retry/Fix-with-AI.
- `VibeTurnPanel.send()` currently creates a new task with empty `workDir` and
  empty `projectName`, despite already receiving the selected project. Even a
  legitimate repair task can therefore run in the wrong repository.
- `DeviceCodeAuth.refreshSession` returns `nil` for every failure. The store
  cannot distinguish an explicitly expired/revoked token from offline, timeout,
  DNS, or backend 5xx conditions.
- `YaverStore.refreshSessionOnLaunch` silently keeps the old token for every
  refresh failure. A definitively expired session can leave the UI appearing
  signed in while account operations fail.
- `TokenStore.save` discards Keychain `OSStatus` values. The UI can claim sign-in
  success without proving that the token was persisted.
- `YaverStore.handleAuthenticationFailure` currently classifies prose and even
  generic `(403)` text. A TV-scope 403 must not sign the user out; only a proven
  account-session rejection should do so.
- Sign Out exists in the dashboard profile menu and at the bottom of TV
  Settings, but the current focus geometry did not let the simulator remote
  reach it reliably.

## Simulator caveat

The original user test reached the authenticated dashboard and then failed on
operations. That is the incident under investigation.

During the later audit, an unsigned Debug tvOS build was installed with
`CODE_SIGNING_ALLOWED=NO`. That installation returned the simulator to Sign In.
An unsigned/re-signed development install changes the app's signing and
Keychain access context, so this later logout is not evidence that the original
QR token failed to persist.

The next end-to-end test must install a normally signed simulator build. Do not
use an unsigned installation to judge Keychain continuity.

## Required auth behavior

The refresh result must be typed rather than inferred from prose:

- HTTP 2xx: keep the current session and adopt a replacement token only if one
  is explicitly returned.
- HTTP 401/403 from the account backend's `/auth/refresh`: the account session
  is definitively invalid, expired, or revoked; clear the local token and
  Keychain and return to Sign In automatically.
- Transport error, timeout, DNS failure, or HTTP 5xx: keep the session and show
  an offline/service failure. Never log the user out for lack of connectivity.
- `auth.session.scope_denied` from an agent: keep the account session and route
  to Update Agent.
- Relay credential rejection: keep the account session and invoke the existing
  relay-repair route.

## Current working-tree UI changes

- Removed the bottom-left tvOS Debug input HUD from the root app surface.
- Removed the now-unused `DebugInputOverlay` implementation.
- Reduced the visible mobile More surface to:
  1. Start Project
  2. Pair Device + Devices
  3. Connection & Network
  4. Settings
- The legacy More inventory is currently excluded from rendering behind the
  lean-surface branch. A later cleanup should delete dead UI/state rather than
  retaining a permanently false branch.

These changes do not implement the auth fixes listed below.

## Next implementation sequence

Status: steps 1–2 landed and built (2026-08-21, HEAD `987d4460f` + working tree).
The simulator app builds, installs, and launches; `YaverTVTests` pass except the
two PRE-EXISTING `testDOMHoverAndSelectUseTheSameClampedViewportCoordinates`
failures (verified by stashing the working tree and re-running — untouched
coordinate math, not this change).

1. Preserve `AgentError.code` through `TVRemoteRuntimeController` instead of
   flattening every error to `localizedDescription`.
   — **DONE.** `AgentClient.ops`/`call`/`rawOps` now decode the structured
     envelope via `AgentError.fromHTTPBody` before falling back to a bare
     `AgentError(message:)` (`tvos/YaverTV/AgentClient.swift`). The REST
     `request` path already did. `TVRemoteRuntimeController` gained a
     `fail(_ error: Error, prefix:)` overload + `@Published var errorCode` that
     preserve the agent's `code`; the two flattening call sites
     (`start()`'s catch and `reloadRuntime`) now pass the real error.
2. Render a dedicated scope-denied recovery card with an Update Agent action;
   do not render Retry/Fix with AI for that verdict.
   — **DONE.** `RemoteRuntimeWebRTCView.runtimeFailurePanel` branches on
     `errorCode == auth.session.scope_denied` (plus the old-agent prose shim)
     to an "This box needs an agent update" card with
     `NavigationLink → UpdateAgentView`, matching `DroidStreamView` and
     `WebPreviewStreamView`. The Retry/Fix-with-AI panel is unchanged for
     genuine render failures.
3. Keep relay rejection separate and route it to relay repair.
   — Partially moot: the live 403 was proven to be the AGENT's
     `auth.session.scope_denied`, not a relay credential denial. Still worth
     doing so a genuine relay 403/401 renders "Repair relay" instead of
     "Try again" — the relay's own verdicts (`relay_password_missing`,
     `relay.device_owner_mismatch`, bandwidth cap) are structured and named.
4. **NEW — ship the allowlist fix.** `6a70b7e3f` (TV-scope `POST /tasks`) is
   in HEAD but unreleased. Publish a new `yaver-cli` agent (≥ the release
   containing it), then update ubuntu-4gb-hel1-1. This is the actual route to
   fix "couldn't start session" from a TV-scoped token.
5. Introduce a typed refresh verdict and auto-sign-out only for a measured
   account-session 401/403.
6. Return and verify the Keychain save result so sign-in cannot report false
   persistence.
7. Pass the selected project's name and path into new Vibing repair tasks.
8. Make Sign Out a deterministic tvOS focus destination and retain the
   destructive confirmation.
9. Strengthen companion-scope parity tests to validate method plus path. The
   current source scan accepts a path when either GET or POST is allowed and can
   miss method drift.
10. Build and install a normally signed tvOS simulator app.
    — **DONE (2026-08-21):** the Debug build installs and launches on the
      "Yaver QR Test TV" simulator; the TV-scoped POST /tasks 403 was captured
      end-to-end from the simulator app logs + the box's agent log.
11. Repeat the complete iPhone scan/approval flow and capture the response body
    for any failed agent/relay request, not merely its HTTP status.
    — The 403 body is captured. Full re-verify needs a real phone: QR scan was
      never tested on the real device (email/password was).

## Deployment status at handoff creation

- No auth fix has been deployed.
- No new TestFlight build was created by this audit.
- Build 294 was the latest build visible in App Store Connect during the user
  check; build 295 was not visible.
- 2026-08-21: a normally signed Debug tvOS simulator build was installed and
  launched on the "Yaver QR Test TV" simulator; the app stays alive (no crash).
  The QR sign-in screen is on screen, but no reachable phone was available to
  scan/approve, so the end-to-end exchange was NOT re-verified this session.
- 2026-08-21 (2nd run): the simulator session was fully exercised. A
  TV-scoped token was minted through the QR flow, the dashboard loaded, and
  `POST /tasks` (start a session) returned 403 `auth.session.scope_denied`
  from ubuntu-4gb-hel1-1 (agent 1.99.411) — root cause confirmed: the TV
  `POST /tasks` allowlist clause is unreleased (see "Broken or incomplete").
  Email/password was verified on the REAL device today; QR scan was never
  tried on the real device.
- 2026-08-21 (commit): steps 1–2 (code-preserving transport + scope-denied
  recovery card) were committed together with this doc. The agent-side allowlist
  fix (`6a70b7e3f`) is in HEAD but UNRELEASED on npm — publish a new
  `yaver-cli` and update ubuntu-4gb-hel1-1 to unblock TV-scoped `POST /tasks`.
