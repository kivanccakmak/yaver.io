# SFMG Mobile Browser Lane Failure Audit — 2026-07-31

Scope: `sfmg` browser preview from the Yaver mobile app on a physical iPhone,
TestFlight `1.18.167` build `496`, targeting the Go agent on
`ubuntu-4gb-hel1-1` through Yaver relay. This audit intentionally focuses on
why the `sfmg` browser lane failed to render from the mobile app. It does not
try to fix `sfmg` directly, and it does not treat "works in the web dashboard"
as proof the mobile lane is healthy.

## Snowball Rule

This is a product failure even if `sfmg` also has a web-runtime bug.

The product let the user reach a state where:

- the project card showed a running browser preview,
- the dev server logs reached `ready 100%` / `Web Bundled`,
- the screen stayed black,
- the only evidence was hidden behind a small `2 issues` / `3 issues` pill,
- tapping `Reload` could repeat the same uncertain state,
- no surface named the actual stage: auth failure, subresource failure,
  bundle-not-mounted, runtime crash, or static-vs-live lane mismatch.

Per Yaver's Snowball principle, the deliverable is not "tell the user to retry"
or "fix this one checkout." The product must make this state impossible or
self-evident next time: detect the actual browser operation, signal a named
stage, show it on the phone while the user is waiting, and offer the correct
route.

## Evidence

Screenshots from the physical device show this sequence:

1. Projects found `sfmg` on `/root/Workspace/sfmg` and classified it as `expo`.
2. The action sheet offered `Browser Reload`, `WebRTC Reload`, and
   `Compile Hermes bundle`.
3. Hermes was correctly constrained: `expo-gl` and `expo-three` require native
   code not present in the Yaver app.
4. `Browser Reload` opened a full-screen mobile preview.
5. The preview remained black.
6. Preview logs initially showed:
   - `Waiting on http://localhost:8084`
   - `[web:error] resource failed SCRIPT https://public.yaver.io/d/<device>/dev-web/node_modules/expo-router/entry.bundle?...token=[redacted]`
7. Later logs showed the Expo web bundle finished:
   - `listening`
   - `ready`
   - `ready 100%`
   - `iOS Bundled 1616ms index.ts (1088 modules)` in one capture
8. The preview still did not show the app.
9. The issue pill increased from `2 issues` to `3 issues`.
10. The log panel had to be opened manually during the failure.

Additional context from the user: the mobile UI browser lane worked for the
Yaver project. A Safari dashboard screenshot shows `yaver / mobile` rendering
successfully through the web dashboard against `ubuntu-4gb-hel1-1`, with
dashboard logs describing `expo export -p web` and `/dev/web-bundle/`.

## Code Paths Verified

The mobile Projects browser action is in
`mobile/app/(tabs)/apps.tsx`. For `Browser Reload`, it calls
`quicClient.startDevServer({ web: true, workDir })`, then opens the WebView.
The intended product comment is explicit: browser reload should serve the web
target and never fall back to Hermes for `sfmg`, because Hermes would die on
native modules such as `expo-gl`.

The mobile preview URL is derived through
`mobile/src/lib/previewBundlePath.ts`. Current logic prefers the agent's
`status.bundleUrl`, with a legacy override from `/dev/` to `/dev-web/` when a
web sibling port exists.

The mobile WebView injects diagnostics from `apps.tsx`:

- console log/warn/error wrapping,
- `window.error` resource-failure capture,
- unhandled rejection capture,
- `PREVIEW_READY_SCRIPT` from `mobile/src/lib/previewReadyScript.ts`.

The ready predicate correctly refuses to call an Expo page rendered merely
because `index.html` exists. For a React/Expo app with `#root`, it requires
children under the mount point.

The Go agent already has an operation-level probe in
`desktop/agent/doctor_browser_lane.go`: `GET/POST /doctor/browser-lane`.
It drives a real browser against the current browser-lane URL and returns a
named stage such as `http`, `blank`, `compiling`, or `rendered`. This is the
right class of product guard, but the failing mobile flow did not appear to use
it automatically.

The web dashboard has a different successful path for mobile web previews.
`web/components/dashboard/RuntimeLabView.tsx` treats `expo` and
`react-native` as static-bundle frameworks and calls
`agentClient.buildWebJSBundle()`, which maps to `POST /dev/build-native` with
`target: "web-js-bundle"` and serves `/dev/web-bundle/`. That is not the same
as the mobile screenshot's live `/dev-web/node_modules/expo-router/entry.bundle`
path.

Local `sfmg/package.json` confirms `sfmg` is a complex Expo 54 app with web
deps present (`react-dom`, `react-native-web`, `@expo/metro-runtime`) plus
native-sensitive modules (`expo-gl`, `expo-three`, `react-native-mmkv`,
`react-native-nitro-modules`, Skia, Reanimated, etc.). So "the app can compile
for web" and "the live mobile WebView lane mounts successfully" must be tested
as separate operations.

## Most Likely Failure Chain

The failure is not a generic "mobile browser lane cannot render anything." The
Yaver project working from mobile and the dashboard working from web rule that
out.

The likely chain is:

1. Mobile starts the live Expo web dev-server lane for `sfmg`.
2. The WebView loads a relay URL under `/d/<device>/dev-web/`.
3. A critical script subresource fails at least once:
   `node_modules/expo-router/entry.bundle?...`.
4. The server later reports healthy bundler output, but the page still does not
   paint a real frame.
5. Mobile collects enough console evidence to increment the issue pill, but it
   does not immediately turn the blank preview into an operation-level result:
   `HTTP auth rejected`, `script subresource failed`, `bundle loaded but #root
   empty`, or `runtime exception before mount`.
6. Because the initial logs are collapsed, the first visible screen is just a
   black preview plus a small issue counter.

The key split is live dev-server vs static web bundle:

- Mobile Projects path: `/dev-web/...entry.bundle` from live Expo web.
- Web dashboard mobile preview path: `/dev/web-bundle/` built with
  `expo export -p web`.

If `sfmg` succeeds under `/dev/web-bundle/` but fails under `/dev-web/`, Yaver
must say exactly that and offer the static-bundle lane on mobile. If both fail,
Yaver must show the first runtime exception or the browser-lane doctor result.

## Product Bugs

### P0 — Mobile Does Not Run the Browser-Lane Doctor on Blank Ready State

The agent already has the right operation probe. Mobile should invoke it when:

- the preview server looks ready,
- `bundleUrl` is non-empty,
- the WebView has not sent `yaver-rendered`,
- or the WebView reports a script/resource failure.

Expected phone result:

> Browser preview reached the dev server, but the app did not paint.
> Stage: blank. Probe: `#root children 0`. Route: view logs / Fix in Yaver /
> build static web bundle.

This must replace generic black screen + issue pill.

### P0 — Logs Must Auto-Unfold Before First Render

During first render, if `webPreviewContentLoaded === false` and any of these
arrive, the log panel must open automatically:

- `[web:error]`,
- `resource failed`,
- `HTTP 4xx/5xx`,
- `unhandled rejection`,
- render-probe timeout,
- doctor stage other than `rendered`.

The screenshot shows the useful evidence existed, but the default surface was
still black with a small issue pill. That violates the rule: advisory chrome
must not hide the route or the cause.

### P0 — Mobile Needs Static Web Bundle Fallback for Expo/RN Browser Preview

The web dashboard already routes Expo/RN previews through
`target: "web-js-bundle"` and `/dev/web-bundle/`. Mobile's Projects browser
lane currently exercises the live `/dev-web/` path. For complex Expo projects
like `sfmg`, those are materially different operations.

Mobile should either:

- default Expo/RN Browser Reload to the same static web-bundle path as web, or
- keep live `/dev-web/` as "Live browser preview" and offer a visible
  "Build web bundle" fallback as soon as live `/dev-web/` fails to paint.

This is especially important because `sfmg` has native-sensitive deps that make
Hermes unavailable inside the Yaver container, while static web export may
still be the correct preview lane.

### P0 — Subresource Failures Need Status and Route

The current WebView diagnostic line says `resource failed SCRIPT <url>`, but
does not name whether the script failed because of:

- relay auth (`401/403`),
- wrong path (`404`),
- response truncation,
- network interruption,
- compile not ready,
- JavaScript parse/runtime error after download.

The main-document `onHttpError` handler is not enough; the failing screenshot
is a subresource script. The product should correlate script failures with an
agent-side probe/fetch of the same URL or run `/doctor/browser-lane` and display
the resulting stage.

### P1 — The Capability Sheet Mixes Hermes Constraints Into Browser Context

The sheet correctly says `expo-gl` / `expo-three` are missing from the Yaver
native container, but that is a Hermes/native constraint. It should not read as
the explanation for Browser Reload. The sheet should separate:

- Browser Reload: web target, no Yaver native module requirement.
- Hermes Reload: blocked by missing native modules.
- WebRTC Reload: possible native-runtime route.

The current sheet mostly does this, but the long warning text is visually
dominant and can mislead during a browser-lane failure.

## Required Verification

Run the actual operation, not inventory checks:

1. Start `sfmg` from mobile or equivalent API on `ubuntu-4gb-hel1-1` with the
   same live browser lane payload (`web: true` / platform web).
2. Capture `/dev/status` once it says ready, including `bundleUrl`, `webPort`,
   `devMode`, `previewHealth`, and recent logs.
3. Call `/doctor/browser-lane` with no hand-built URL so it probes the exact
   current URL including query auth.
4. Record whether the doctor stage is `rendered`, `http`, or `blank`.
5. If blank, capture the probe state: mount id, mount children, visible boxes,
   body text, and first console exception.
6. Build `target: "web-js-bundle"` for the same `sfmg` workDir and load
   `/dev/web-bundle/` from the mobile WebView.
7. Compare live `/dev-web/` vs static `/dev/web-bundle/`.

The guard is only proven when disabling the failing condition makes the test
fail: e.g. break subresource auth or throw before React mount and verify mobile
shows the named stage with logs unfolded.

## Immediate Product Change List

1. Mobile Projects browser preview: auto-open logs before first render when the
   first runtime/resource issue arrives.
2. Mobile Projects browser preview: after ready + no paint, call
   `/doctor/browser-lane` and render its named stage.
3. Mobile Projects browser preview: add static web-bundle fallback for Expo/RN,
   matching the web dashboard's `/dev/web-bundle/` path.
4. Mobile and `DevPreview`: share the same browser-lane doctor consumer and
   log auto-unfold rule.
5. Agent: expose enough doctor/browser-lane detail for subresource script
   failure diagnosis without leaking tokens.
6. E2E: add `sfmg`-shape fixture or external test that distinguishes:
   live `/dev-web/` succeeds, live `/dev-web/` blank, static `/dev/web-bundle/`
   succeeds, and static bundle blank.

## Bottom Line

`sfmg` failed in the mobile browser lane because the product accepted "dev
server ready" as too much evidence while the real operation — a WebView loading
the app's script through relay and mounting React into the page — did not
complete visibly.

The strongest code-level clue is the surface split: mobile used live
`/dev-web/...entry.bundle`; the web dashboard's successful mobile-web preview
path uses static `expo export -p web` served from `/dev/web-bundle/`. The next
product fix should make mobile prove and display that distinction instead of
leaving the user with a black screen and a hidden log panel.
