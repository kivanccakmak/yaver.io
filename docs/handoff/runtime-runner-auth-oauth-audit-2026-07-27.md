# Runtime Target, Runner Auth, and Remote OAuth Audit Handoff

Date: 2026-07-27  
Repo: `yaver.io`  
Purpose: hand this to Claude Code or another coding agent to re-audit the recent fixes around Web UI RuntimeLab, device runner auth status, and remote OAuth flows.

## Read This First

Do not trust this file as source of truth. Use it as a map, then grep the code.

Start with:

```bash
git log --oneline -5
git show --stat a63d16ead
git show --stat b188b205d
git show --stat 6ca563494
```

Then inspect the current code, especially:

```bash
rg -n "AuthVerified|authVerified|authConfigured|runnersAvailable|DetectRunnerRuntimeStatus|RunnerInfo" desktop/agent backend/convex web
rg -n "startRunnerBrowserAuth|submitRunnerBrowserAuth|RunnerBrowserAuth|callback|codeInput" web desktop/agent mobile backend/convex
rg -n "invalid token|Agent auth needs refresh|Reconnect & Retry|reauthAgent|ownerClaimDevice|triggerReconnect" web desktop/agent backend/convex
rg -n "RuntimeLabView|VibeCodingView|DevicesView|connectToDevice" web/components web/app
```

## User-Visible Bugs Observed

1. Devices showed Claude Code or Codex as `signed in` even when opening that runner produced a connection/auth failure.
2. RuntimeLab target loading sometimes showed only `invalid token` and left the user with no recovery action.
3. Claude Code and Codex remote OAuth from web had inconsistent behavior depending on whether the dashboard was opened from `localhost` or production `https://yaver.io`.
4. Device three-dot runner actions could launch a PTY or failed command when the runner was not authenticated, instead of starting the remote OAuth flow.
5. The Vibing panel had a better remote OAuth pattern than Devices; Devices should use the same first-class flow.
6. Runtime target detection initially treated `yaver.io` monorepo as only Web UI, missing `mobile` as a first-class target.
7. Mobile preview needed phone/tablet sizing, default phone sizing, a loading phone frame, Yaver logo, and less noisy controls.
8. Runtime logs needed live streaming, auto-scroll behavior, and clearer right-side chat/log layout.
9. OpenCode model plumbing initially produced `ProviderModelNotFoundError` because the selected UI model/provider did not match the machine's real OpenCode config.
10. Login in RN-web preview hit `n.default.setValueWithKeyAsync is not a function`, which is a separate mobile/web compatibility bug around secure storage/native module substitution.

This handoff focuses mainly on items 1, 2, 3, 4, and 9. Re-audit the other items if touching RuntimeLab or mobile preview code.

## What Was Already Changed

### Commit `a63d16ead` - Carry verified runner auth in device status

Intent: stop losing real runner auth state between the Go agent, Convex, and web UI.

Expected code shape:

- `desktop/agent/auth.go`
  - `RunnerInfo` has fields like:
    - `Installed`
    - `Ready`
    - `AuthConfigured`
    - `AuthVerified`
    - `AuthSource`
    - `Warning`
    - `Error`
- `desktop/agent/tasks.go`
  - `GetRunnerInfos()` decorates runner heartbeat rows with runtime auth status from `DetectRunnerRuntimeStatus`.
  - Synthetic runner rows also carry the auth fields.
- `backend/convex/schema.ts`
  - device heartbeat `runners[]` accepts optional auth fields.
  - `cloudMachines.runnersAvailable[]` accepts optional `verified`.
- `backend/convex/devices.ts`
  - device runner auth fields are written into Convex.
  - `runnersAvailable` mirror derives `authed` from `authVerified` where possible, not merely from credential presence.
- `backend/convex/cloudMachines.ts`
  - `runnersAvailable` supports `verified`.
- web device types include `authVerified`.

Audit concern: verify no path still converts `status: "ready"` directly to green signed-in for Claude or Codex.

### Commit `b188b205d` - Require verified auth for runner green state

Intent: make stale/legacy heartbeat rows safer in the web dashboard.

Expected code shape:

- `web/components/dashboard/DevicesView.tsx`
  - Claude/Codex should require `authVerified === true` for green `signed in`.
  - If only `authConfigured` or `status: ready` exists without verified auth, show amber `verify needed` or equivalent.
  - OpenCode is different: it can be represented by config/API-key/provider availability, and should be audited separately against real OpenCode config.

Audit concern: the menu text and cards must agree. If the card says `Claude Code signed in`, clicking Claude must not fail with a connection/auth error unless auth expired after the last heartbeat. If stale, the UI should say when it was verified.

### Commit `6ca563494` - Make runtime auth failures recoverable

Intent: `invalid token` in RuntimeLab is Yaver agent/session auth, not a render-target discovery failure.

Expected code shape:

- `web/components/dashboard/RuntimeLabView.tsx`
  - has `isAgentAuthErrorMessage(...)`.
  - catches `invalid token`, 401, 403, unauthorized, session expired errors in target loading.
  - displays `Agent auth needs refresh`.
  - offers `Reconnect & Retry` and `Retry only`.
  - calls `onReconnect` if provided, then retries `loadCapabilities`.
- `web/app/dashboard/page.tsx`
  - passes `onReconnect={connectedDevice ? async () => { await connectToDevice(connectedDevice); } : undefined}` to `RuntimeLabView`.

Audit concern: this only improves RuntimeLab target loading. If other surfaces show raw `invalid token`, they need equivalent recovery using the existing reconnect path.

## Deployed State

Already pushed to `main`.

Cloudflare production deployed:

```text
Current Version ID: 31d4f7b1-2906-406e-ac5e-8277ecd3a61a
```

Convex production was deployed for the schema/backend runner auth changes:

```text
https://perceptive-minnow-557.eu-west-1.convex.cloud
```

Smoke check performed:

```bash
curl -I 'https://yaver.io/dashboard?tab=runtime'
# HTTP/2 200
```

Checks performed:

```bash
go test . -run 'TestAuth|TestRunnerAuth|TestRunnerPTY|TestRemoteStatusAuth'   # in desktop/agent
npx tsc --noEmit                                                              # in web
npm --prefix web run build
git diff --check -- web/components/dashboard/RuntimeLabView.tsx web/app/dashboard/page.tsx
```

## Deep Diagnosis

### False `signed in`

Root issue: the UI trusted inventory/proxy signals too much.

Bad shape:

```text
runner exists on PATH
or config file exists
or heartbeat says ready
=> dashboard says signed in
```

Correct shape:

```text
runner installed
AND runner auth probe actually succeeded recently
=> signed in
```

For Claude Code and Codex, the useful truth is not whether the binary exists. It is whether the runner can perform an authenticated operation or the runner-specific auth status check succeeds. The Go agent must report both:

- configured/present: credential material appears to exist
- verified: the runner proved it can use that auth

The dashboard should render:

- `signed in`: verified true
- `verify needed`: configured true but verified false/unknown
- `sign in needed`: not configured or explicit unauthenticated
- `unavailable`: binary not installed or unusable

The stale-data problem still matters. If Convex has an old row from a previous agent version with no `authVerified`, web must not infer green for Claude/Codex.

### `invalid token` in RuntimeLab

This is not Claude/Codex OAuth. It means the browser's call path to the Yaver agent has a bad/expired/mismatched Yaver auth token or relay/device session.

Likely path:

```text
Web dashboard -> agentClient -> remote device/relay -> Go agent runtime endpoint
```

Failure:

```text
Load Targets
invalid token
```

The product previously exposed the raw error and stranded the user. The correct UX is:

1. Explain this is agent auth/session refresh, not target detection.
2. Offer reconnect/reauth.
3. Retry the same target probe after reconnect.
4. Keep the logs so the user can see what happened.

`RuntimeLabView` now does that for target load. Claude should verify whether the same pattern is needed in:

- projects loading
- runtime session create
- web preview create/open
- dev event streaming
- task create/chat send
- Devices menu PTY launch

### Remote OAuth: Localhost vs Production

There are two different OAuth classes:

1. Yaver account/device auth
   - This controls dashboard access to the remote agent.
   - Errors show as `invalid token`, unauthorized, 401/403, device cannot reach, reauth needed.
2. Runner auth for Claude Code/Codex
   - This signs in a specific remote runner on a specific remote machine.
   - Browser opens provider URL.
   - OAuth callback may end at `http://localhost:<port>/callback?...`.
   - In remote-machine flow, that localhost is usually on the user's browser machine, not the remote Ubuntu machine.

The working pattern from mobile/Vibing is:

- start remote runner auth session on the target machine
- show provider URL
- browser opens provider auth page
- if browser ends on localhost callback, user can paste the full callback URL
- additionally, for flows that return a token/code directly, provide a secondary input for that token/code
- submit callback/code to the remote agent/session for the selected runner

Critical requirement: Codex callback/token handling must not be mixed with Claude Code callback/token handling. Store and submit by auth session ID and runner ID.

Claude should audit:

```bash
rg -n "startRunnerBrowserAuth|getRunnerBrowserAuthStatus|submitRunnerBrowserAuthCallback|submitRunnerBrowserAuthCode" web mobile desktop backend
rg -n "claude|codex|oauth|callback|localhost" desktop/agent web mobile backend/convex
```

Expected UI behavior:

- From Vibing settings:
  - Runner dropdown can select OpenCode, Claude Code, Codex.
  - If selected runner requires sign-in, show clear sign-in flow.
  - For Claude Code remote OAuth, show callback URL paste field and token/code field when applicable.
- From Devices three-dot menu:
  - Runner entries should show signed-in/sign-in-needed/verify-needed status.
  - Clicking unsigned Claude/Codex should open the same remote OAuth modal, not a PTY that immediately fails.
  - Clicking signed-in Claude/Codex can open PTY or set preferred runner, depending on the action label.

### OpenCode First-Class Plumbing

OpenCode must not be hardcoded as `zai` globally. In the user's current machine config, Z.ai GLM is the configured provider/model, so it should be detected and used as default for that machine.

Correct shape:

- Go agent reads OpenCode config from the remote machine.
- It reports provider/model/auth/config snapshot to Convex/web.
- Convex stores latest OpenCode config per machine with timestamp.
- Web seeds runner/model UI from Convex immediately.
- Web can refresh from live agent when connected.
- Chat task creation passes the model in the form OpenCode expects.

The failure observed:

```text
ProviderModelNotFoundError
providerID: "gpt-5.4"
modelID: ""
Error: Model not found: gpt-5.4/.
```

Expected for this user's machine:

```text
runner: opencode
provider: zai-coding-plan
model: zai-coding-plan/glm-5.2 or zai-coding-plan/glm-4.7
```

Audit:

```bash
rg -n "openCodeConfig|OpenCodeConfig|opencodeConfigByDevice|primaryModelByDevice|safeModelForRunner|ProviderModel" web desktop/agent backend/convex mobile
```

Make sure:

- UI dropdown model values match the runner's expected model value.
- Provider prefix is preserved only if OpenCode expects it.
- `setPrimaryRunner` stores enough structured info to avoid reconstructing provider by splitting strings later.
- The task creation path sends the same normalized model string in web and mobile.

## Specific Follow-Up Work To Ask Claude Code

### 1. Re-audit runner auth freshness

Goal: no false green.

Tasks:

- Find every UI place that renders runner auth status.
- Ensure Claude/Codex green requires verified auth.
- Add stale timestamp language where possible: `verified 2m ago`, `not verified`, or `verify needed`.
- Ensure Convex updates from current Go agent heartbeats.
- Ensure older agents/older rows degrade to amber, not green.

Suggested tests:

- Unit test status derivation with:
  - `authVerified: true`
  - `authVerified: false, authConfigured: true`
  - missing `authVerified`, `status: ready`
  - missing runner binary
- Go test for `GetRunnerInfos()` preserving verified false.

### 2. Make Devices runner click open remote OAuth modal

Goal: clicking unsigned Claude/Codex in Devices does not open a failing PTY.

Tasks:

- Locate Devices menu runner actions.
- If runner is unsigned or verify-needed, open the runner auth modal.
- Reuse Vibing/RuntimeLab auth session UI and state shape.
- Include:
  - provider auth URL
  - callback URL paste field
  - token/code input field
  - status polling
  - retry/cancel
- Label per runner: `Sign in Claude Code`, `Sign in Codex`.

Do not mix Claude Code token/code with Codex token/code. Bind every submission to `{ deviceId, runner, authSessionId }`.

### 3. Harden localhost callback handling

Goal: remote OAuth works when dashboard is on both `localhost` and `https://yaver.io`.

Tasks:

- Trace exact callback flow for Claude Code and Codex.
- If callback lands on user browser localhost, make paste field primary and obvious.
- If provider supports redirect to production callback, make production callback route deliver to session.
- If local callback cannot be reached by remote machine, do not wait forever; show explicit instructions and paste field.
- Add timeout and recovery state.

Test matrix:

- web dashboard on `https://yaver.io`
- web dashboard on `http://localhost:3010/dashboard?tab=runtime`
- remote Ubuntu target
- local Mac target
- Claude Code OAuth
- Codex OAuth

### 4. Spread agent auth recovery beyond Load Targets

Goal: any `invalid token` has recovery, not just RuntimeLab target load.

Search:

```bash
rg -n "catch \\(err|setError\\(|invalid token|Could not|connectError" web/components web/app web/lib
```

Patch likely surfaces:

- project inventory
- runtime session create
- web preview create
- task create/chat send
- dev event stream connection
- device PTY open

Use one helper if possible:

```ts
isAgentAuthErrorMessage(message)
```

But do not over-broaden. `invalid token` from Claude/Codex provider auth is not the same as Yaver device auth. Context matters.

### 5. Confirm OpenCode config snapshot is truly first class

Goal: no more `gpt-5.4/` accidental provider/model mismatch when machine config says Z.ai GLM.

Tasks:

- Inspect remote `opencode` config probe in Go.
- Verify Convex stores latest config with timestamp.
- Verify web and mobile read the same config.
- Verify selected model persists per machine.
- Verify task create uses effective model and provider in the form OpenCode expects.

Add regression around:

```text
available model: zai-coding-plan/glm-5.2
selected model: gpt-5.4
expected: correct to zai-coding-plan/glm-5.2 or block with clear UI
```

## Manual Repro Checklist

Use `ubuntu-4gb-hel1-1` as the main remote target if available.

1. Open `https://yaver.io/dashboard?tab=devices`.
2. Confirm device row shows per-runner statuses:
   - Claude Code
   - Codex
   - OpenCode
   - GLM/provider if present
3. If Claude/Codex is not verified, click its runner action.
4. Expected: remote OAuth modal opens, not PTY.
5. Complete OAuth.
6. If callback lands on `http://localhost:<port>/callback?...`, paste that full URL into the modal.
7. Confirm row updates after heartbeat or explicit refresh.
8. Open `https://yaver.io/dashboard?tab=runtime`.
9. Select `yaver / mobile`.
10. Click `Load Targets`.
11. If `invalid token` occurs, click `Reconnect & Retry`.
12. Expected: reconnect runs and target probe retries automatically.
13. Open Vibing chat and send `helo`.
14. Expected: selected runner/model matches device setting and returns output.

## Product Rule From This Incident

Inventory is not proof. A binary on PATH, a config file, or a heartbeat `ready` flag is only inventory. The product must either verify the operation or render the state as unverified.

When operation auth fails, the UI must explain which auth layer failed:

- Yaver device/session auth: reconnect/re-auth machine.
- Claude Code/Codex runner OAuth: sign in that runner on that machine.
- OpenCode provider/API-key config: fix OpenCode provider config on that machine.

Do not collapse these into one `signed in` badge or one `invalid token` string.

