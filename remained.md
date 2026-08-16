# Remaining Audit: Mac mini runner sign-in + remote rendering

Date: 2026-07-26  
Input evidence:

- `/Users/kivanccakmak/Downloads/ScreenRecording_07-26-2026 10-32-21_1.MP4`
- Screenshots from 2026-07-26 10:29-10:30 showing `e-mobile` preview failure on `Mobiles-Mac-mini`
- Current repo code in `desktop/agent`, `mobile/src`, `web/components`, `tvos`, and `visionos`

No credentials or pasted auth codes are included here.

## Executive summary

Two different failures are visible and they are getting blended in the product UI:

1. **Remote Claude Code sign-in on the Mac mini did not complete because the mobile app never received a usable verification URL from the remote CLI session.** The recording shows the modal sitting on "Waiting for the verification URL from the remote CLI..." and later surfacing "no response". That means the user could not even reach the part where they authorize Claude and paste the callback token.
2. **Remote rendering from the Mac mini is still failing for at least one Flutter project (`e-mobile`) because the app itself does not compile under the current Flutter web toolchain.** The visible error is from `image_editor_plus-1.0.8`: `FaIconData` cannot be assigned to `IconData?`. Yaver now has agent-side compile-failure detection, but the mobile task surface is still showing a huge raw purple log dump and "Working..." instead of a compact failed state with a fix.

The Snowball lesson is: **Yaver knows more than the UI tells the user.** The agent has better classifiers and event streams than the mobile task surface is currently using, and the runner-auth flow collapses several different transport/subprocess failures into "no response".

## Claude Code sign-in failure: what the recording proves

The screen recording frames show:

- Mobile app is connected to `Mobiles-Mac-mini`.
- The runner-auth dialog is for `Claude Code`.
- The transport indicator alternates between relay/connected states, then shows degraded states such as "no response".
- The dialog text stays on:
  - "Starting the sign-in flow on the remote machine..."
  - "Waiting for the verification URL from the remote CLI..."
  - "Paste the code from Claude Code" with no `openUrl` visible.
- There is no successful transition to a visible authorize URL, pasted-token verification, or completed state.

This points to the first broken boundary before user authorization:

```text
mobile RunnerAuthModal
  -> AgentClient.startRunnerBrowserAuth("claude")
  -> Mac mini agent /runner-auth/browser/start
  -> spawn: claude auth login --claudeai
  -> parse stdout/stderr for https://...
  -> return session.openUrl
```

The recording shows the last step never reached the phone.

## Claude Code sign-in: likely root causes

### 1. The remote CLI did not emit a URL in the form Yaver parses

The Go agent only captures an auth URL by scanning stdout/stderr lines with:

```go
urlPattern = regexp.MustCompile(`https://[^\s]+`)
```

and then setting `session.openUrl`.

If current Claude Code prints the login link through a TTY-only UI, OSC-8 hyperlink, stderr sequence, wrapped line, local browser handoff, or a non-`https://` deep link, the session remains in `starting` even though the subprocess is alive.

Product gap:

- The mobile UI can only say "waiting".
- The agent does not expose "CLI is alive but has emitted no URL for N seconds".
- The flow does not fall back to an explicit console/device-code mode when URL capture stalls.

Required fix:

- Add a runner-auth watchdog: if `claude auth login --claudeai` has no captured URL after ~10 seconds, mark the session `blocked_waiting_for_cli_url` with recent sanitized output and a specific remedy.
- Teach the Claude auth command path to prefer a stable non-interactive URL/code mode when Claude Code supports one. If `--claudeai` only works interactively on the installed version, detect that and say so.
- Add parser tests for current Claude Code auth output, including ANSI/OSC-8 hyperlink forms and wrapped URLs.

### 2. Remote transport failure is surfaced as the generic string "no response"

The native Swift client has paths that throw:

```swift
throw AgentError(message: "no response")
```

when there is no HTTP response object. The mobile/web clients have equivalent generic error behavior in some flows.

That message does not tell the user which hop failed:

- phone -> relay
- relay -> Mac mini agent
- peer proxy -> runner-auth route
- route started process but status polling timed out
- process still running but no URL

Required fix:

- Change runner-auth status/start responses to include a structured `phase`, `lastOutputAt`, `spawned`, `openUrlCaptured`, `transport`, and `targetDeviceId`.
- Change mobile/web/tvOS/visionOS surfaces to render the phase, not the generic transport exception.
- Preserve per-endpoint failure detail: LAN failed, relay failed, HTTP status, JSON body error, timeout duration.

### 3. macOS Claude auth storage and daemon context are still fragile

The code already acknowledges a real macOS trap:

- Claude Code stores subscription credentials in Keychain.
- Yaver agent may run from launchd/SSH and not share the same GUI security context.
- `CLAUDE_CONFIG_DIR` is set on local Claude login to encourage a file credential path.

But the failed recording happened before visible authorization, so this is probably not the immediate failure. It is still the next likely failure after URL capture is fixed.

Required fix:

- After auth completes, run `claude auth status --json` from the same environment the agent uses for tasks.
- If the browser flow succeeded but `auth status` still fails, surface: "Claude signed in to the GUI Keychain, but the Yaver daemon cannot read it. Import credentials or restart the agent in the user session."
- Add a doctor probe for "Claude Code auth is visible to interactive terminal but invisible to Yaver daemon".

### 4. No direct log pull is shown on the mobile auth dialog

The Go handler logs important events:

- spawned command
- captured URL
- code received
- terminal status

But the phone dialog does not show those as a compact timeline. In the recording, the user is left guessing.

Required fix:

- Add a runner-auth event stream or polling timeline to the modal:
  - command resolved
  - process started
  - output seen
  - URL captured
  - code submitted
  - CLI completed
  - post-auth status verified
- Redact tokens and URLs only if needed; never log pasted auth code values.

## Remote rendering failure: what the screenshots prove

The `e-mobile` preview on `Mobiles-Mac-mini` shows:

```text
flutter · port 9101 · hot reload on
mode · browser preview
target · this device
Failed to compile application.
```

The visible compile error is:

```text
image_editor_plus-1.0.8/lib/modules/text.dart:29:43: Error:
The argument type 'FaIconData' can't be assigned to the parameter type 'IconData?'.

image_editor_plus-1.0.8/lib/modules/text.dart:40:43: Error:
The argument type 'FaIconData' can't be assigned to the parameter type 'IconData?'.

image_editor_plus-1.0.8/lib/modules/text.dart:51:43: Error:
The argument type 'FaIconData' can't be assigned to the parameter type 'IconData?'.

Failed to compile application.
```

This is not a blank-screen transport issue. It is a Flutter/Dart dependency compatibility failure in the project build lane Yaver selected.

Likely project-level cause:

- `image_editor_plus 1.0.8` is not compatible with the installed Flutter / Dart / `font_awesome_flutter` combination.
- `FaIconData` is not assignable to the `IconData?` expected by the widget API in this dependency version set.

Yaver-side product problem:

- The agent has compile-failure detection in `desktop/agent/devserver.go` and `desktop/agent/devserver_start_remedy.go`.
- The mobile task surface still renders the raw log dump and keeps saying "Working... implementation details hidden while the task runs."
- The user sees a running card and a working task even though the preview is already terminally blocked until dependencies/code change.

Required fix:

- Promote dev-server compile failures to a terminal task/update state when the user is on a preview task.
- Render a compact failure panel:
  - `Flutter compile failed`
  - offending package/file
  - first concrete error
  - suggested action
  - `View logs` for full tail
- Do not keep the task status as "mapping... still working" when the preview has a persisted `compileError`.

## Rendering: classification/lane concerns

The screenshot says:

```text
mode · browser preview
target · this device
```

For Flutter, browser preview is usually the correct default for a generic remote preview surface. The current repo already has tests asserting Flutter should default to web rather than hunting for a native device. So this specific failure is not "Yaver picked iOS when it should pick web".

The remaining classification risks are:

- Monorepos can expose multiple valid app roots. Yaver must start Flutter from the directory containing the intended `pubspec.yaml`, not the repo root or a sibling package.
- Some Flutter apps are not web-compatible even if they contain a `web/` directory. In that case browser preview should fail honestly and suggest native simulator/device lanes.
- If a dependency compile failure is web-only, Yaver should be able to say "browser lane failed; native iOS/Android may still work" rather than treating all rendering as failed.

Required fix:

- Store `lane = flutter-web` vs `flutter-ios` vs `flutter-android` in the dev-session status and event stream.
- Attach build failure to the lane, not only to the project.
- Add a "try native lane" action only when a native target is actually available and the project supports it.

## Cross-surface gaps still visible

### Mobile app

Current visible problems:

- Runner-auth modal waits without a phase timeline.
- Transport failure can collapse to "no response".
- Flutter compile failure is shown as oversized raw log text.
- Task remains visually "working" after preview compilation has already failed.

Needed:

- Structured runner-auth phases.
- Structured render failure panel.
- Dev-session failure should update the task surface.
- Full logs behind a button, not as the primary screen.

### Web dashboard / Selenium

The web dashboard has a similar runner-auth modal. It should receive the same structured session phases, not duplicate a separate interpretation.

Needed:

- One shared wire contract for `runnerBrowserAuthSession`.
- Web renders the same phase/remedy strings as mobile.
- Selenium test must assert that a stalled Claude URL capture becomes a named blocked state, not an infinite spinner.

### tvOS / visionOS

Recent work added `/dev/events` log streaming to native surfaces. The remaining parity item is runner-auth:

- tvOS has runner-auth QR concepts.
- visionOS cannot rely on QR scanning.
- Both need the same phase/remedy model as mobile, especially for "remote CLI did not emit URL".

Needed:

- `runner_auth` ops should return structured blocked phases.
- tvOS can show QR when `openUrl` exists.
- visionOS should offer in-headset open URL and phone-assisted fallback without QR as a dependency.

## Security constraints

Runner auth must keep these invariants:

- Pasted Claude auth codes/tokens must never be logged.
- Tokens must not go to Convex.
- Relay must remain pass-through; it must not become an auth authority.
- The box must verify same-owner/public-key access as it does today.
- Importing credentials must write only to the target runner's expected credential path with `0600` permissions.
- Tenant/guest runtimes must not allow subscription credentials to be imported or run under the wrong user.

## Convex/cost constraints

Do not fix this by polling Convex faster.

Preferred low-cost paths:

- Runner-auth status polling goes directly to the agent over LAN/relay HTTP.
- Dev logs stream over `/dev/events` SSE from the agent.
- Convex only stores durable device/account metadata and coarse operation state.
- Bounded recent-log tails only; no full build logs in Convex.

## Concrete remaining implementation plan

### P0: Make Claude sign-in failure self-evident

1. Add `phase` to `runnerBrowserAuthSession`, for example:
   - `starting`
   - `spawned`
   - `waiting_for_cli_url`
   - `awaiting_browser`
   - `awaiting_code_paste`
   - `verifying`
   - `completed`
   - `failed`
   - `blocked_no_cli_url`
2. Track `lastOutputAt`, `lastSanitizedOutput`, and `spawnedCommandLabel`.
3. Add a 10-15 second no-URL watchdog for Claude auth.
4. Surface a specific blocked message:
   - "Claude Code started on the Mac mini but did not print a browser verification URL. This Claude version may require an interactive TTY or a different auth mode."
5. Add parser fixtures for current Claude Code auth output.
6. Add mobile/web UI rendering for the new phases.

### P1: Make render compile failures first-class task failures

1. Feed `compileError` from `/dev/status` and `/dev/events` into the task surface.
2. Stop showing "Working..." as the dominant state after a terminal compile failure.
3. Replace the purple raw dump with a compact failure card.
4. Keep full logs behind `Logs`.
5. Add a regression test using the observed `image_editor_plus` / `FaIconData` error.

### P2: Close the lane classification loop

1. Include `lane` in status/events: `flutter-web`, `flutter-ios`, `expo-web`, `rn-native`, etc.
2. Persist lane-specific failures.
3. Add "try another lane" only when Yaver has proved that lane exists.
4. Monorepo discovery should report the exact app root and why it was selected.

### P3: Closed-loop tests

1. Selenium/web:
   - start runner auth
   - simulate no URL emitted
   - assert blocked state and remedy
2. iOS simulator:
   - open runner auth modal
   - replay stalled session
   - assert no infinite spinner
3. Agent Go tests:
   - Claude auth URL parser handles ANSI, OSC-8, wrapped URLs
   - no-URL watchdog emits blocked state
4. Flutter render tests:
   - observed compile error becomes `compileError`
   - task UI switches from working to failed/remedy

## Current confidence

High confidence:

- The rendering issue in the screenshots is a Flutter compile failure, not a WebRTC/iframe/relay blank-screen issue.
- The mobile UI is still not consuming the agent's compile-failure intelligence correctly.
- The Claude sign-in failure occurred before the user could authorize because no usable verification URL reached the modal.

Medium confidence:

- Claude Code's current output format or invocation mode is incompatible with the parser/flow on the Mac mini.
- The generic "no response" came from a relay/peer HTTP path rather than the Claude subprocess itself.

Needs direct Mac mini log confirmation:

- Exact `[runner-auth-browser]` lines for the failed session.
- Whether `claude auth login --claudeai` printed anything.
- Whether `claude auth status --json` works in the agent environment.
- Whether the Mac mini agent version includes the latest runner-auth fixes.

## One-command evidence to gather next on the Mac mini

Run from the agent's user context, redacting tokens:

```sh
claude --version
claude auth status --json
YAVER_RUNNER_AUTH_DEBUG=1 yaver serve
```

Then start Claude sign-in from the phone and inspect only sanitized lines like:

```text
[runner-auth-browser] claude spawned: ...
[runner-auth-browser] claude line=...
[runner-auth-browser] claude captured openUrl=...
[runner-auth-browser] claude session ... terminal status=...
```

If `line=` never appears, the CLI produced no parseable output or blocked on TTY/browser launch. If `captured openUrl=` appears but the phone still says waiting/no response, the bug is in relay/proxy/status polling. If the code is submitted but terminal status is failed, the bug is post-authorization credential storage or daemon Keychain visibility.
