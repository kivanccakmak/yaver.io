# Mobile Preview Health / Lane Selection Audit — 2026-07-28

## Context

This audit records the product fixes made after mobile preview dogfooding on
`sfmg` and `e-mobile` from the Yaver mobile app, including a remote
`runner-box` browser/WebView render path.

Observed failures:

- React Native / Expo browser preview could still leak into the Hermes bundle
  path, producing Hermes bytecode validation errors while the WebView/browser
  lane was the chosen surface.
- Action sheets advertised runtime surfaces that the project did not actually
  contain, such as watch/TV/vision/car options for a mobile-only app.
- `Fix in Yaver` appeared while logs were normal startup or healthy progress:
  `queued`, `flutter run ...`, `listening`, `ready`, `Bundled ...`.
- Preview logs were not open early enough during startup, leaving the user with
  a black screen even though the agent was streaming useful output.
- Mobile had local log heuristics deciding whether a project needed fixing;
  the Go agent did not provide a structured "things are going well / not going
  well" signal for clients to consume.

The product rule being enforced: **do not show `Fix in Yaver` while the agent
knows the preview is starting, progressing, ready, or blocked by a deterministic
machine/setup route. Show it only for a real project compile/runtime failure
with no deterministic fixer.**

## Changes Already Pushed

Commit already pushed to `github/main`:

- `cb72c3e42 Fix browser preview lane selection`

That commit did the following:

- Made RN/Expo project preview options lead with `Browser Reload`, then Hermes,
  then WebRTC.
- Kept Browser Reload in the browser/WebView lane by preventing browser reloads
  from falling back into `/dev/reload-app` Hermes rebuilds.
- Added code-driven remote runtime target filtering so watch/tv/vision/wear/auto/XR
  targets only appear when project files or markers exist.
- Updated mobile fallback lane ordering so older agents still prefer browser
  first for RN/Expo projects.
- Opened preview logs by default until the first rendered frame and stripped
  ANSI escape codes from log output.
- Added top preview controls including a mic/vibing entry point.

## New Uncommitted Changes In This Follow-Up

These files are currently modified and not yet committed:

- `desktop/agent/devserver.go`
- `desktop/agent/devserver_start_remedy_test.go`
- `mobile/app/(tabs)/apps.tsx`
- `mobile/src/components/DevPreview.tsx`
- `mobile/src/lib/quic.ts`

### Agent Signal

`desktop/agent/devserver.go` now defines `PreviewHealth` and attaches it to:

- `DevServerStatus.previewHealth`
- `DevServerSnapshot.previewHealth`

The field is derived inside the Go agent from:

- active capability gaps
- dev-server status
- `status.Error`
- recent log tail already captured by the dev server manager
- existing Go compile-failure detection via `devBuildFailureLine` /
  `compileErrorLines`

Current states:

- `starting`
- `healthy`
- `needs_project_fix`
- `infrastructure_gap`
- `unknown`

Important behavior:

- `queued`, startup commands, building state, and healthy logs produce
  `canOfferProjectFix: false`.
- capability gaps produce `canOfferProjectFix: false` and
  `hasDeterministicFix: true`.
- real compile failures produce `state: "needs_project_fix"` and
  `canOfferProjectFix: true`.
- generic status errors such as "browser preview exited" or port/setup-style
  messages do not produce project-fix escalation.

### Mobile Consumption

`mobile/src/lib/quic.ts` adds the `PreviewHealthSignal` type and exposes
`DevServerStatus.previewHealth`.

Both mobile preview implementations now prefer the agent signal:

- `mobile/app/(tabs)/apps.tsx`
- `mobile/src/components/DevPreview.tsx`

Rules now used by mobile:

- If `previewHealth.canOfferProjectFix` exists, it is authoritative.
- `Fix in Yaver` is shown only when:
  - `previewHealth.canOfferProjectFix === true`
  - `previewHealth.state === "needs_project_fix"`
  - `previewHealth.hasDeterministicFix !== true`
- Local log regexes remain only as fallback for older agents that do not yet
  emit `previewHealth`.

This means healthy/working states from the agent suppress `Fix in Yaver` even if
old local heuristics would have been noisy.

## Verification Run

Passed:

```bash
cd desktop/agent
go test . -run 'TestPreviewHealth|TestCompileFailureIsRecognisedAndExplained|TestRemoteRuntimeCapabilities|TestRNLeadsWithBrowserReload'
```

Passed:

```bash
cd mobile
npx tsc --noEmit
```

Passed:

```bash
node --experimental-strip-types --test \
  mobile/src/lib/devLane.test.mts \
  mobile/src/lib/mobileProjectActions.test.mts \
  mobile/src/lib/compileFailure.test.mts \
  mobile/src/lib/previewPhase.test.mts
```

## What Needs Audit

1. Confirm `PreviewHealth` is placed on every status/snapshot path clients use.
   Check `/dev/status`, `/dev/events` snapshot, and any alternate guest/dev
   manager path.

2. Confirm the agent classifier is not too narrow.
   It currently keys real project failures off existing compile-failure shapes
   and selected status-error strings. It may need explicit runtime-error shapes
   from web logs if those are expected to trigger `Fix in Yaver`.

3. Confirm the agent classifier is not too broad.
   It must not classify:
   - `queued`
   - `flutter run ...`
   - `npm run ...`
   - `listening`
   - `ready`
   - `Bundled ...`
   - render-probe timeout with otherwise healthy server
   - connection dropped / relay disconnected
   as project-fix-needed.

4. Confirm old local mobile fallbacks cannot override a healthy agent signal.
   The intended rule is agent signal wins whenever present.

5. Confirm `compileCard` does not make `Fix in Yaver` appear when agent health
   says healthy/starting. The current code gates `Fix in Yaver` with
   `previewAgentHealthIsAuthoritative(...)` for the failure overlay, but this
   should be reviewed carefully in both mobile preview implementations.

6. Confirm snapshot updates do not race with status polling.
   Mobile merges `event.snapshot.previewHealth` into the current status object.
   If `status` is `null`, it currently does not create one just for health.
   That may be acceptable, but audit whether early startup with no status should
   still carry preview health in UI state.

7. Confirm stale logs from a previous session cannot poison current health.
   `recentLogTail` is reset by the existing dev-server manager paths, but this
   should be rechecked because stale "failed to compile" lines would wrongly
   surface `needs_project_fix`.

8. Confirm all product surfaces consume or can ignore the new field safely.
   The field is additive JSON, but web/tv/watch/car clients may still have their
   own `Fix in Yaver` logic that should migrate to `previewHealth`.

9. Confirm no deterministic repair route is hidden behind `Fix in Yaver`.
   Capability gaps should show install/reconnect/repair actions, not a coding
   task. `PreviewHealth.hasDeterministicFix` exists to make this explicit.

10. Confirm the browser lane still cannot trigger Hermes fallback.
    `reloadDevServerDetailed({ allowBundleFallback: false })` is used for the
    browser path. Audit other callers that may call reload from browser/WebView
    context without passing that flag.

## Known Missing Work

- The new `previewHealth` follow-up is not committed or pushed yet.
- No full end-to-end mobile device test was run after the follow-up; only
  TypeScript, focused Node tests, and focused Go tests were run.
- Web dashboard and other non-mobile surfaces have not been migrated to consume
  `previewHealth`.
- The health signal currently focuses on dev-server/build health, not on a full
  browser render lifecycle. A WebView can still fail to paint after a healthy
  server; that should be represented as render health separately from project
  fix health.
- `webRuntimeIssueCount` may still count warnings for the badge, even though it
  no longer necessarily shows `Fix in Yaver`. Audit whether warnings should be
  visually counted as "issues" or shown as "logs/warnings".
- Runtime JS errors emitted by the page may need structured classification from
  the agent or preview probe instead of mobile-only log parsing.
- The vibing mic button opens the existing vibing modal; a full mic/text overlay
  switch matching Tasks may need a separate UX pass.

## Suggested Audit Commands

```bash
git diff -- desktop/agent/devserver.go desktop/agent/devserver_start_remedy_test.go \
  'mobile/app/(tabs)/apps.tsx' mobile/src/components/DevPreview.tsx mobile/src/lib/quic.ts
```

```bash
rg -n "previewHealth|canOfferProjectFix|Fix in Yaver|previewLogsNeedProjectFix|detectCompileFailure" \
  desktop/agent mobile web
```

```bash
cd desktop/agent
go test . -run 'TestPreviewHealth|TestCompileFailureIsRecognisedAndExplained'
```

```bash
cd mobile
npx tsc --noEmit
```

## Acceptance Criteria

- While preview logs show normal startup/progress/ready output, `Fix in Yaver`
  is not visible.
- When the agent has a deterministic repair route, that route is shown instead
  of `Fix in Yaver`.
- When the project genuinely fails to compile or run, `Fix in Yaver` is visible
  with the relevant log lines.
- Browser/WebView reload never invokes Hermes build/validation.
- Unsupported project surfaces are absent, not disabled.
