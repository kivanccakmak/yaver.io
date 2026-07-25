# Browser-Based Remote Box Runner Analysis

Date: 2026-07-24

This is a source-referenced handoff for analyzing browser-driven Yaver remote box usage: task runners, dev preview, runner auth, peer proxy, cloud placement, sandbox, rescue/recovery, and browser transport constraints.

The code is the source of truth. The Markdown architecture docs were used only as context and every concrete claim below is tied back to code that was inspected.

## Executive Summary

Browser-based remote-box usage is not a single path. It is a family of paths:

1. The browser discovers devices through Convex-backed device state.
2. The browser proves actual reachability through relay, tunnel, or direct HTTP.
3. The browser connects an `AgentClient` to a specific agent.
4. The browser starts tasks, runner auth, installs, dev servers, previews, terminals, project transfer, or recovery against that agent.
5. Some flows operate on the active connected box directly.
6. Some flows target another box through `/peer/<deviceId>/...`.
7. Some flows must use special browser-only auth shims because iframes, images, videos, EventSource, and WebSocket constructors cannot reliably attach arbitrary headers.
8. Some flows are deliberately not remote-proxyable because they involve secrets or streaming.

The main areas that deserve follow-up hardening are:

- Distinguishing "device heartbeat is online" from "this browser can reach it".
- Avoiding mixed-content direct HTTP probes from an HTTPS dashboard.
- Keeping relay choice consistent between the browser client and same-origin preview proxy.
- Avoiding accidental use of `/peer` for streams/assets/WebSockets/large bodies.
- Making browser-preview auth boundaries obvious because `/dev/...` content delivery differs from command/control auth.

## Primary Browser Client

Source: `web/lib/agent-client.ts`

The primary browser control plane is `AgentClient`.

Important locations:

- `AgentClient` class starts around `web/lib/agent-client.ts:1642`.
- Relay config and relay password persistence are around `web/lib/agent-client.ts:1696`.
- `connect(host, port, token, deviceId, opts)` stores the target and candidate transport details around `web/lib/agent-client.ts:1721`.
- `baseUrl` chooses active relay `/d/<deviceId>`, tunnel, or direct `http://host:port` around `web/lib/agent-client.ts:3136`.
- `authHeaders` adds bearer auth and, for active relay, `X-Relay-Password` around `web/lib/agent-client.ts:3158`.
- `attemptConnect` tries relay first, then tunnel, then direct around `web/lib/agent-client.ts:3860`.
- `startPolling` polls `/tasks?limit=5` and emits output lines around `web/lib/agent-client.ts:3977`.

Key behavior:

- Relay transport uses `${relay}/d/${deviceId}` as the base URL.
- Tunnel transport uses a supplied tunnel URL.
- Direct transport uses `http://host:port`.
- Relay calls add `X-Relay-Password`.
- Browser currently avoids sending `X-Yaver-Caller` because CORS/preflight behavior drifted; see comments around `authHeaders`.
- If any probe observes auth-expired behavior, connection failure is reported as auth-expired rather than generic unreachable.
- Relay limit errors are also prioritized.

Risk notes:

- `attemptConnect` still tries direct `http://host:port` after relay/tunnel candidates. From an HTTPS dashboard, browsers generally block mixed-content HTTP fetches. Other code paths explicitly skip direct HTTP in that situation. This is probably not an auth bug, but it can create noisy or misleading diagnostics.
- The active relay URL stores the relay origin, not a `/d/<deviceId>` path. Any code that tests `activeRelayUrl.includes('/d/<id>')` should be treated as suspicious.

## Task Runner Path

Sources:

- `web/lib/agent-client.ts`
- `desktop/agent/httpserver.go`
- `desktop/agent/tasks.go`

Browser task creation:

- `sendTask` / `createTask` post to `/tasks` around `web/lib/agent-client.ts:1778`.
- The request source is stamped as `web`.
- `409 cloud_workspace_required` is decoded into a special browser-side error.

Agent route:

- `/tasks` route is registered around `desktop/agent/httpserver.go:342`.
- Task list/create/delete handling is around `desktop/agent/httpserver.go:3944`.
- Task creation logic is around `desktop/agent/httpserver.go:4205`.
- Task-specific operations are handled around `desktop/agent/httpserver.go:4562`.
- Output streaming starts around `desktop/agent/httpserver.go:4643`.

Important server-side constraints:

- Guest access is restricted.
- Guest-supplied `workDir` is not trusted.
- Guest custom commands are blocked.
- Guest/feedback execution can require Docker isolation.
- Ask mode is owner-only.
- Owner-only task options are stripped from guest flows.
- Placement preview can return `409 cloud_workspace_required` before a local task is created.

Task list hardening:

- The task list response is bounded. Comments in `httpserver.go` document real production incidents where huge task lists or huge `ResultText` fields made the relay look broken.
- Current behavior caps default/max list counts and response size.

Runner definitions:

- First-class runners are `claude`, `codex`, and `opencode` around `desktop/agent/tasks.go:247`.
- Built-in runner configs are around `desktop/agent/tasks.go:145`.
- Claude uses `claude -p ... --dangerously-skip-permissions`.
- Codex uses `codex exec --full-auto`.
- OpenCode uses `opencode run --dangerously-skip-permissions`.

## Browser Runner Auth

Sources:

- `web/app/dashboard/page.tsx`
- `web/components/dashboard/DevicesView.tsx`
- `desktop/agent/runner_auth_browser_http.go`
- `desktop/agent/runner_auth_mirror_http.go`

Dashboard runner auth modal:

- Starts browser auth with `agentClient.startRunnerBrowserAuth(runner, target)` around `web/app/dashboard/page.tsx:4148`.
- Polls status every 1.5 seconds.
- Shows URL/code.
- Supports manual code paste for Claude.
- Target may be a peer device id.

Devices view:

- Runner test/install/sign-in flows are around `web/components/dashboard/DevicesView.tsx:560`.
- Owner-only; guests are rejected.
- Creates a fresh `AgentClient` for the selected device.
- Auto sign-in is attempted when a runner needs auth and supports browser auth.

Agent runner auth:

- Browser auth session code is in `desktop/agent/runner_auth_browser_http.go`.
- Only `codex` and `claude` are supported for browser auth.
- Codex runs `codex login --device-auth`.
- Claude runs `claude auth login --claudeai`.
- For Claude non-tenant auth, the agent sets `CLAUDE_CONFIG_DIR=$HOME/.claude` so daemon-visible credentials land where the runner can read them.
- Stale sessions for the same runner/tenant are canceled.

Mirror auth:

- `/runner/auth/mirror/request` and `/runner/auth/mirror/accept` live in `desktop/agent/runner_auth_mirror_http.go`.
- Request reads local runner credentials if available.
- Accept is owner-only and rejects guest headers.
- Ledger returns metadata only.

Risk notes:

- OpenCode does not use browser auth. It depends on local credentials/config.
- Browser-auth support should not be inferred for arbitrary future runners.

## Dev Preview And Browser Content Proxy

Sources:

- `web/components/dashboard/PreviewPane.tsx`
- `web/app/d/[deviceId]/[[...path]]/route.ts`
- `desktop/agent/devserver_http.go`
- `desktop/agent/httpserver.go`

PreviewPane:

- `previewUrl = agentClient.devPreviewUrl` is used around `web/components/dashboard/PreviewPane.tsx:734`.
- Preflight fetch of iframe URL is around `web/components/dashboard/PreviewPane.tsx:768`.
- Prompt-from-preview creates a task around `web/components/dashboard/PreviewPane.tsx:971`.
- Reload uses `/dev/reload` modes around `web/components/dashboard/PreviewPane.tsx:1055`.
- Stop uses `stopDevServer` around `web/components/dashboard/PreviewPane.tsx:1070`.
- Start project posts to `/dev/start` around `web/components/dashboard/PreviewPane.tsx:1123`.

Same-origin `/d/<deviceId>` proxy:

- Implemented in `web/app/d/[deviceId]/[[...path]]/route.ts`.
- It loads relay config/settings, chooses a relay target, and proxies requests to `${relayUrl}/d/${deviceId}/${path}`.
- It forwards a small request-header allowlist.
- It injects `X-Relay-Password` server-side.
- On relay-password-related 401s, it calls `/settings/repair-relay` and retries.
- It rewrites proxied HTML/CSS root asset paths for `/d/<deviceId>/dev/...`.
- It injects a script so browser client routers see `/` rather than `/d/<id>/dev/...`.

Agent dev routes:

- `/dev/status`, `/dev/start`, `/dev/stop`, `/dev/reload`, `/dev/reload-app`, `/dev/events`, `/dev/build-native`, `/dev/native-bundle`, `/dev/assets`, `/dev/web-bundle`, and `/dev/` catchall are in `desktop/agent/devserver_http.go` and `desktop/agent/httpserver.go`.
- `/dev/start` rejects invalid Linux-only paths rather than accepting a broken workdir.
- `/dev/web-preview/start` is a separate Expo Web preview path for React Native browser iframes.
- `/dev/build-native` has active build tracking so `/dev/stop` can cancel hung builds.

Security note:

- Browser preview/content routes are not equivalent to command/control routes.
- Some dev content endpoints are no-auth content delivery paths because apps, iframes, native bundles, or webviews need to fetch assets without custom auth headers.
- Over relay, the relay path is still gated by relay password.
- On direct LAN, preview content should be treated as exposed to the LAN unless the dev app itself has its own auth.

Risk notes:

- The same-origin proxy appears to choose the first configured relay. `AgentClient` has relay priority sorting elsewhere. If Convex config is not already sorted, preview and control-plane paths may choose different relays.
- Any future preview feature should avoid requiring custom headers from iframes/assets/EventSource/WebSockets.

## Browser Session Tokens For Headerless APIs

Source: `web/lib/agent-client.ts`

Some browser APIs cannot attach auth headers:

- `<iframe>`
- `<img>`
- `<video>`
- `EventSource`
- Browser-native `WebSocket`

`AgentClient` has helper logic around `web/lib/agent-client.ts:3202` to issue `/auth/browser-session` tokens and append query params such as:

- `browser_session`
- `__rp` for relay password where needed

This is a necessary browser compatibility layer. Treat these URL-bearing credentials as scoped and short-lived. Avoid leaking them into logs, copied UI text, analytics, or persistent storage.

## Peer Proxy

Sources:

- `desktop/agent/peer_proxy_http.go`
- `desktop/agent/mcp_remote_proxy.go`
- `web/lib/agent-client.ts`

Generic peer proxy:

- `/peer/<deviceId>/<path>` is implemented in `desktop/agent/peer_proxy_http.go`.
- It reads a bounded request body, currently 8 MiB.
- It rejects local target proxying to avoid recursion.
- It proxies through `proxyToDevice`.
- It passes responses back with JSON content type.

MCP-style remote proxy:

- `proxyToDevice` is in `desktop/agent/mcp_remote_proxy.go`.
- Empty or matching device id returns local handling.
- Cross-device secret-like Layer 4 operations are explicitly blocked.
- Blocked operations include vault/env/token/deploy credential related verbs.
- It forwards the caller bearer token where needed and marks `X-Yaver-Proxied-Tool`.
- Remote request timeout is 120 seconds.

Browser usage:

- Web-side Git/provider/clone calls can route to either local agent or `/peer/<target>/git/...` and `/peer/<target>/repos/clone`.
- Runner auth/install flows can target peers.

Risk notes:

- `/peer` is not a general streaming proxy.
- Do not use `/peer` for iframe preview, WebSockets, SSE, native bundle fetches, large project uploads, or raw assets.
- The 8 MiB body limit is appropriate for JSON control calls, not project transfer.

## Device Discovery, Status, And Browser Reachability

Sources:

- `web/lib/device-lifecycle.ts`
- `web/components/dashboard/DevicesView.tsx`
- `web/lib/transport.ts`

Lifecycle model:

- `deriveDeviceLifecycleState` is separate from `deriveBrowserReach`.
- This is intentional. Heartbeat/Convex state does not prove browser reachability.
- Comments mention a prior bug class where Convex said the device was live but the browser could not actually reach it.

Important code:

- Browser failure window and reach states are in `web/lib/device-lifecycle.ts`.
- Device status labels avoid saying "Ready to Connect" unless browser reach is actually verified.
- Device probe/reset logic is around `web/components/dashboard/DevicesView.tsx:1123`.
- Runtime info probe candidates around `web/components/dashboard/DevicesView.tsx:1350` use same-origin `/d/<deviceId>` for non-active relay device cards so relay password is injected server-side.
- Transport classification is in `web/lib/transport.ts`.

Risk notes:

- Backend online state, browser reachability, and iframe asset reachability are different capabilities.
- Bugs tend to happen when the UI collapses these into a single "online" boolean.

## Dashboard Connection And Cloud Dispatch

Source: `web/app/dashboard/page.tsx`

Dashboard connect:

- Proactive reauth before connect is around `web/app/dashboard/page.tsx:1644`.
- Connect flow is around `web/app/dashboard/page.tsx:1687`.
- It calls `agentClient.connect`, then `/info`, then runner list.
- It updates Convex with side-channel live agent version when stale.
- On auth-related errors it attempts owner claim or reauth and reconnect.

Cloud dispatch reconciliation:

- Pending cloud dispatch logic is around `web/app/dashboard/page.tsx:1760`.
- The browser merges local pending dispatch records with Convex dispatch intents.
- It polls placement status.
- If a target device exists and is not connected, the browser connects to that target.
- Once connected, the browser posts the task body to the target agent.
- After dispatch, it rebinds placement and marks intent dispatched.

Task creation:

- Around `web/app/dashboard/page.tsx:2108`, task creation handles `cloud_workspace_required`.
- If cloud workspace is required, it records a local placeholder/queued state rather than pretending a local task exists.

Risk notes:

- Convex dispatch intents do not appear to store the full prompt/body. That is good for privacy, but it means dispatch depends on the originating browser retaining pending task payload locally.
- Switching browsers/devices mid-dispatch may require careful UX because another surface may see the intent but not have the full body needed to post `/tasks`.

## Convex Placement

Sources:

- `backend/convex/taskPlacement.ts`
- `backend/convex/cloudMachines.ts`

Placement decision:

- `decidePlacement` is around `backend/convex/taskPlacement.ts:392`.
- It considers active subscription/product, profile/classifier, force flags, owned devices, runner installation, build needs, relay-source eligibility, and cloud entitlement.
- Owned devices can win if online, authenticated, compatible, and runner-capable.
- Cloud can win for forceCloud, build needs, or non-relay resource needs.
- Manual is returned when no suitable local/cloud/relay-source option exists.

Placement status:

- `preview`, `record`, `getStatus`, and `rebindTask` live around `backend/convex/taskPlacement.ts:582`.

Cloud machines:

- Deterministic managed device id is `cloud-<machineId short>` around `backend/convex/cloudMachines.ts:103`.
- `wake` seeds status/device id and schedules resume around `backend/convex/cloudMachines.ts:1708`.
- `resumeHealthCheck` probes agent health and only marks active when the agent is usable around `backend/convex/cloudMachines.ts:2664`.
- Bootstrap/auth-expired states move to an awaiting-auth phase with bounded recovery.
- If recovery does not progress, wake is abandoned and the machine is parked to avoid cost leakage.
- Auto-park cannot be disabled around `backend/convex/cloudMachines.ts:3114`.

Risk notes:

- Placement knows whether a box is online/authenticated/capable from backend state. It does not necessarily prove the current browser can reach it.
- Managed cloud wake health checks prove backend-to-agent usability. That may not be identical to user-browser reachability, depending on DNS/relay/tunnel conditions.

## Auth Bootstrap, Recovery, And Rescue

Sources:

- `desktop/agent/auth_bootstrap.go`
- `desktop/agent/auth_recover.go`
- `web/lib/agent-client.ts`

Bootstrap:

- Tokenless agents can start a relay tunnel in bootstrap mode if relay password and device id are present.
- If managed box device id is missing, a deterministic cloud id can be derived from `/etc/yaver/machine.json`.
- `/info` returns bootstrap/needsAuth/lifecycle state.
- Passkey options are only exposed when direct and visible, not proxied.
- Agent notifies Convex about bootstrap-pending devices.

Recovery:

- Auth recovery exists specifically to fix remote signed-out boxes without SSH.
- `AgentClient.reauthAgent` tries relay paths first.
- Direct recovery is skipped when browser HTTPS mixed-content rules would block direct HTTP.
- Recovery supports owner claim, direct recovery, pair mode, and pair-code submit flows.

Rescue:

- Browser can queue Convex-backed rescue commands when normal relay paths are broken.
- Rescue is a fallback path, not the normal command/control plane.

Risk notes:

- Auth recovery depends on identity binding and relay reachability. Error text should remain explicit about whether failure is auth, relay, mixed content, or ownership mismatch.

## Remote Runtime / Browser-Window Runtime

Sources:

- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_browser.go`

Runtime modes:

- `rn-hermes`
- `web-webview`
- `native-webrtc`

Framework mapping:

- Expo/React Native generally map to Hermes.
- Next/Vite/React/Firebase/Supabase/Convex/Yaver serverless map to web-webview.
- Swift/Kotlin/Flutter/browser map to native/WebRTC-related runtime.
- Browser framework can be rendered as a headless Chromium tab streamed to a spatial/web client.

Browser-window runtime:

- `remote_runtime_browser.go` launches headless Chromium via chromedp.
- Frames are captured as JPEG and sent over a data channel.
- Pointer/keyboard events are translated through CDP.
- Touch emulation is configured.

Risk notes:

- This is a distinct path from normal iframe dev preview. It is remote-rendered browser state, not direct iframe loading from the user’s browser.
- Debugging needs to distinguish:
  - browser iframe preview
  - web-webview runtime
  - browser-window remote runtime
  - native WebRTC runtime

## Remote Sandbox

Source: `desktop/agent/sandbox_remote.go`

Flow:

- Browser/mobile sends a prompt and bounded file snapshot to `/sandbox/run`.
- Agent validates paths and sizes.
- Agent writes files into a temp `yaver-sandbox-remote-*` workdir.
- Agent runs OpenCode with the configured GLM/Z.ai model.
- Agent snapshots edits and returns an edit plan.
- Temp directory is removed afterward.

Limits:

- Max files: 400.
- Max total bytes: 2 MiB.
- Max file bytes: 512 KiB.
- Default timeout: 180 seconds.
- Max timeout: 600 seconds.
- Absolute paths, `..`, backslashes, and Windows volume paths are rejected.
- Ignored directories include dot dirs, `node_modules`, `vendor`, `dist`, `build`, and `.expo`.

Privacy note:

- Unlike placement metadata, sandbox prompt and source files are sent to the selected box.
- The selected box may then send prompt/source context to the runner provider through OpenCode.

## Guest / Host Share / SDK Scope Boundaries

Source: `desktop/agent/httpserver.go`

Host share allowlist:

- Host-share access is restricted to explicitly allowed route groups.
- The allowlist includes info/status/runners/ops, selected filesystem/host-share paths, and websocket terminal only under policy.
- It does not broadly allow `/tasks`.

Scoped SDK/guest paths:

- Scoped SDK tokens can reach feedback, blackbox, builds, testapp, health, todolist, guest-reload, guest-vibing, circuit, stream, and runner-auth related scopes.
- Guest SDK demotion prevents scoped SDK tokens from becoming owner-equivalent.

Task guest restrictions:

- Even where guest task creation is allowed by the relevant auth wrapper, guest-controlled `workDir` and custom commands are constrained.

Risk notes:

- Never infer owner-level access from successful access to a scoped route.
- Keep future runner/task routes explicit about whether they are owner, guest, host-share, or SDK scoped.

## Transport Classification

Source: `web/lib/transport.ts`

Transport classes include:

- Active relay
- Tunnel
- Tailscale
- WSL
- Private LAN
- Direct public

Important behavior:

- Active relay classification is for the active device only.
- This avoids falsely labeling non-active devices with the currently connected transport.

Risk note:

- UI labels should not imply a non-active device is using the active device’s relay/tunnel path.

## Key Invariants To Preserve

1. Relay is transport, not authorization.
2. The box validates ownership/device auth.
3. Convex heartbeat does not prove browser reachability.
4. Browser reachability does not prove iframe/asset/WebSocket reachability.
5. `/peer` is for bounded control requests, not general streams/assets.
6. Secret operations must not be proxied cross-device by MCP `device_id`.
7. Guest/SDK tokens must remain scoped and must not become owner-equivalent.
8. Preview/content endpoints must not be treated like authenticated command endpoints.
9. Task body privacy depends on posting actual prompts to the selected agent, not storing them in Convex placement records.
10. Cloud wake must remain bounded and self-parking when auth/bootstrap does not converge.

## Suggested Follow-Up Checks

1. Check whether `AgentClient.attemptConnect` should skip direct HTTP when `window.location.protocol === "https:"`, matching other paths that already avoid mixed content.
2. Audit `DevicesView` active-device project probing for `activeRelayUrl.includes('/d/<deviceId>')`; based on current `AgentClient` shape, that condition looks unlikely to ever match.
3. Confirm whether Convex relay config is already priority-sorted before the `/d/<deviceId>` same-origin proxy chooses `relays[0]`.
4. Add or verify a doctor/probe that distinguishes:
   - Convex online
   - backend health reachable
   - browser fetch reachable
   - iframe/content reachable
   - websocket/event stream reachable
5. Add explicit comments or route metadata for `/dev/...` content routes documenting why some are no-auth content delivery and what protects them over relay/direct LAN.
6. Ensure pending Cloud Workspace dispatch UX clearly handles browser reload/device switch before the task body is posted to the selected agent.
7. Confirm `/peer` callers are not using it for streams, asset delivery, WebSockets, or large payloads.
8. Keep runner-auth capability checks per runner. Do not generalize Claude/Codex browser-auth assumptions to OpenCode or future runners.

## Files Inspected

- `CLAUDE.md`
- `docs/architecture/AI_ARCH.md`
- `docs/architecture/REMOTE_WORKER.md`
- `web/lib/agent-client.ts`
- `web/app/dashboard/page.tsx`
- `web/components/dashboard/DevicesView.tsx`
- `web/components/dashboard/PreviewPane.tsx`
- `web/app/d/[deviceId]/[[...path]]/route.ts`
- `web/lib/device-lifecycle.ts`
- `web/lib/transport.ts`
- `desktop/agent/httpserver.go`
- `desktop/agent/tasks.go`
- `desktop/agent/devserver_http.go`
- `desktop/agent/mcp_remote_proxy.go`
- `desktop/agent/peer_proxy_http.go`
- `desktop/agent/runner_auth_browser_http.go`
- `desktop/agent/runner_auth_mirror_http.go`
- `desktop/agent/auth_bootstrap.go`
- `desktop/agent/auth_recover.go`
- `desktop/agent/remote_runtime.go`
- `desktop/agent/remote_runtime_browser.go`
- `desktop/agent/sandbox_remote.go`
- `backend/convex/taskPlacement.ts`
- `backend/convex/cloudMachines.ts`
