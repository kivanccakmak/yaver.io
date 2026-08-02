# Web/Mobile One-To-Many + Voice Render Handoff — 2026-08-01

## Context

User goal started as: make Yaver respond to Siri-like invocations such as
`open yaver app and render todo-rn` or `open sfmg`, then broadened to all
assistant/action-launcher surfaces, not Siri only. During verification the user
stopped the iOS build and redirected to an official release only after
one-to-many device connections are covered.

The screenshots show:

- mobile can open `todo-rn` via the Yaver TestFlight app after the Expo web
  target finishes loading.
- a reload can still fail with `No mobile SDK listener or browser bundle preview
  is connected on this agent`.
- web Devices lists multiple boxes, but only `ubuntu-4gb-hel1-1` is connected.
  Other boxes are alive by heartbeat but unreachable from web:
  `Relay refused: account relay password missing or stale` or `Unauthorized`.
- user complaint: web UI is still not genuinely one-to-many.

## Work Completed In This Session

### Voice / Action Launcher Render Plumbing

Implemented a platform-neutral render intent parser and mobile deep-link handler:

- `mobile/src/lib/renderIntent.ts`
  - Parses `yaver://render?...`, `https://yaver.io/render/...`,
    `yaver://shortcut?...`, and `https://yaver.io/shortcut/...`.
  - Normalizes project, device, mode, and reload intent.
  - Converts render intents to existing `openAppBus` payloads.
- `mobile/src/lib/renderIntent.test.mts`
  - Covers custom-scheme render links, HTTPS render links, shortcut links, and
    generic shortcut launcher links.
- `mobile/src/lib/pairLinkHandler.tsx`
  - Routes render links to the Apps surface.
  - Selects `primary`, explicit device id/name/alias/voiceHint, or the active
    device.
  - Runs named/id shortcuts through existing shortcut APIs.
  - Keeps existing pair/device-code/runner-auth deep links working.

Added assistant/launcher entry points:

- `mobile/ios/Yaver/YaverRenderIntents.swift`
  - Adds App Intents for render-project and run-shortcut phrases.
  - Added to `mobile/ios/Yaver.xcodeproj/project.pbxproj`.
- `mobile/android/app/src/main/AndroidManifest.xml`
  - Adds verified HTTPS deep links for `/render*` and `/shortcut*`.
  - Adds static shortcuts metadata.
- `mobile/android/app/src/main/res/xml/shortcuts.xml`
  - Static launcher shortcuts for render and shortcut.
- `mobile/android/app/src/main/res/values/strings.xml`
  - Shortcut labels.
- `mobile/app.json`
  - Expo Android intent filters for `/render*` and `/shortcut*`.
- `web/app/api/apple-app-site-association/route.ts`
  - AASA now includes `/render*` and `/shortcut*`.
- `web/app/render/page.tsx`, `web/app/shortcut/page.tsx`,
  `web/app/shortcut/[id]/page.tsx`
  - Browser fallback pages that attempt to open the app with `yaver://...`.

### Preview Reload Fix

Implemented a shared reload planner:

- `mobile/src/lib/previewReload.ts`
  - Decides browser vs native reload lane.
  - Native lane uses bundle/fast reload semantics and can open native first.
  - Browser lane re-keys the WebView.
- `mobile/src/lib/previewReload.test.mts`
  - Pins native/browser lane decisions and failure copy.
- `mobile/src/components/DevPreview.tsx`
  - Uses the planner.
  - Stops showing a blocking Alert for reload failures.
  - Keeps last good preview visible and shows inline failure text.
- `mobile/app/(tabs)/apps.tsx`
  - Same planner path for Apps surface reload.

### Web One-To-Many Partial Fix

Root observation: web already has `AgentClientPool`, but the main dashboard
still mostly uses the legacy singleton `agentClient`. `connectToDevice()`
disconnects the singleton when switching devices, so web behaves like one active
device at a time even though relay `/d/<deviceId>` can address many devices.

Partial implementation:

- `web/lib/agent-client.ts`
  - `AgentClientPool` now stores relay topology and topology-refresh hooks.
  - New clients inherit relay servers and refresh hook.
  - Added `connectedDeviceIds()`.
  - Added `subscribe()` + internal notifications for membership/state changes.
- `web/app/dashboard/page.tsx`
  - Imports `agentClientPool`.
  - Pushes relay topology and topology refresh hook into the pool whenever the
    singleton receives them.
  - Tracks pooled `connectedDeviceIds`.
  - After a successful focused connect, mirrors that device into the pool.
- `web/components/dashboard/DevicesView.tsx`
  - Accepts `connectedDeviceIds`.
  - Device cards show `connected in background`.
  - Background-connected cards show `Focus Workspace`, not `Open Workspace`.

## Verification Completed

Before the user stopped the build:

- `mobile`: render intent tests, preview reload tests, existing dev-lane test,
  and TypeScript passed.
- `web`: TypeScript passed before the later partial one-to-many edits.
- `android`: `./gradlew :app:processDebugMainManifest :app:mergeDebugResources`
  passed.
- iOS simulator build was intentionally stopped by user request. The stop exited
  code 75 due cancellation, not due a known compile error.

After the redirect:

- I stopped the Xcode build and verified no `xcodebuild`, `clang`, or
  `swift-frontend` process from this build remained.
- I did not deploy or submit to TestFlight after the user said official release
  must wait until one-to-many is covered.

## Main Issue

Web is still not fully one-to-many because most dashboard surfaces are wired to
the singleton `agentClient`, not to a per-device client. The pool exists but is
not yet the source of truth for:

- PreviewPane/Web Reload
- Chat/task stream
- shell modal
- runner browser auth routing
- per-device actions in many dashboard cards
- role-routed runner/render split under simultaneous connections

The product therefore can show multiple devices and can classify per-card
failures, but opening/focusing one machine can still rebind the active singleton
away from another machine.

## Specific Risks In The Current Partial Web Patch

- `agentClientPool.subscribe()` now notifies on client creation and
  connection-state changes, but it has not been covered by tests yet.
- `rememberPooledConnection()` reconnects the pooled client after the singleton
  succeeds. It should be refactored to avoid double probing when the active
  singleton could be inserted/reused directly.
- The focused singleton still disconnects on switching devices. That may remain
  acceptable for legacy tabs, but the UI must not imply all connections are
  dropped.
- Several unrelated pre-existing edits are in the same files, especially
  `web/app/dashboard/page.tsx` and `web/lib/agent-client.ts` task-proof changes.
  Claude Code must review file diffs carefully and avoid reverting unrelated
  work.

## Remote Box State From Screenshot

Do not mutate boxes blindly. Current screenshot state:

- `ubuntu-4gb-hel1-1`: connected, private network, v1.99.390, update available
  to v1.99.393.
- `magara`: alive by heartbeat, renderer, relay refused because account relay
  password is missing or stale.
- `Kvancs-MacBook-Air.local`: alive by heartbeat, unauthorized.
- `Mobiles-Mac-mini.local`: alive by stale heartbeat, relay password missing or
  stale.
- `Ofis2`: alive by heartbeat, relay password missing or stale.
- `simkab-Vostro-3888`: offline.

Safe repair route is product-first:

1. keep the web/mobile surfaces honest with named causes;
2. offer in-place relay credential repair or reauth when the route is
   invocable;
3. queue desired updates through Convex when a box is unreachable;
4. only run remote commands through authenticated Yaver routes.

`yaver devices` from this local terminal hung after printing the install line
for CLI 1.99.393; it was interrupted. Treat that as another reason not to rely
on CLI inventory alone.

## What Claude Code Should Do Next

1. Re-read `CLAUDE.md`, this file, and the current diffs on disk.
2. Add focused tests before continuing web pool migration:
   - `web/lib/agent-client.test.ts`: pool propagates relay config to clients
     created before and after `setRelayServersOnAll`.
   - `web/lib/agent-client.test.ts`: two pooled clients can both remain
     connected to different mock agents.
   - dashboard/component test or headless test: switching focus does not erase
     the background-connected badge.
3. Replace transient/singleton per-device actions in `DevicesView.tsx` with
   pooled helpers where safe:
   - runner test/install,
   - agent update status,
   - ping/probe paths,
   - runner browser auth start when target differs from focused workspace.
4. Add or extend a closed-loop headless script:
   - `web-headless`: connect to two mock or live relay-addressed devices.
   - `mobile-headless`: assert mobile and web agree on primary/secondary/role
     semantics.
   - `e2e/connectivity-truth-loop.mjs`: add one-to-many assertion if fixtures
     are stable enough.
5. Re-run:
   - `cd web && npx tsc --noEmit --pretty false`
   - `cd mobile && npx tsx src/lib/renderIntent.test.mts && npx tsx src/lib/previewReload.test.mts && npx tsc --noEmit --pretty false`
   - `cd mobile/android && ./gradlew :app:processDebugMainManifest :app:mergeDebugResources`
   - iOS build only after App Intents syntax is reviewed.
6. Only after green verification and explicit user confirmation, use
   `./deploy/deploy.sh ios` for TestFlight. Do not call lower-level deploy
   scripts directly.

## Open Questions

- Should web maintain a focused singleton forever, or should dashboard tabs be
  migrated to `agentClientPool.get(activeDeviceId)` and delete singleton usage
  incrementally?
- Should `Open Workspace` warm/connect all role devices immediately when
  machine roles are configured, matching mobile’s role warm-up?
- Should relay-password repair be run once automatically for all live
  heartbeat devices after sign-in, or only per device when a probe proves a
  relay credential denial?
- iOS App Intents compile status is unknown because the build was stopped before
  reaching the app target.
