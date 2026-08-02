# Voice / Action Launcher Render Plan — 2026-08-01

Goal: make OS-level voice/action entrypoints such as **"Hey Siri, render
todo-rn in Yaver"**, **"Hey Google, open sfmg in Yaver"**, launcher shortcuts,
universal/app links, car/watch/TV actions, and Shortcuts.app actions drive the
same deterministic Yaver render pipeline as the in-app buttons.

This is not an iOS-only feature. Siri is one entrypoint into a cross-surface
contract that must also work from mobile, Android, web, tvOS, watchOS, Wear OS,
car, visionOS / AR, CLI, and MCP.

## Current Code Reality

Markdown may be stale. Verify these anchors before implementing.

- iOS custom scheme exists in `mobile/app.json` (`scheme: "yaver"`) and
  `mobile/ios/Yaver/Info.plist` (`CFBundleURLSchemes`).
- iOS scene forwarding now exists in
  `mobile/ios/Yaver/YaverSceneDelegate.swift`. This was added because the
  CarPlay scene manifest previously caused `yaver://` links and quick actions
  to be dropped before React Native saw them.
- Home-screen quick action support exists only for car voice:
  `io.yaver.mobile.carVoice` in `AppDelegate.swift` / `Info.plist`.
- No native `AppIntent`, `AppShortcutsProvider`, Siri donation, or
  parameterized Siri phrase exists yet.
- Android currently accepts `yaver://` scheme links. Verified HTTPS app links
  and static launcher shortcuts need to share the same render-intent contract
  rather than inventing Android-only routes.
- In-app shortcut storage and execution exist:
  - `backend/convex/shortcuts.ts`
  - `mobile/src/lib/shortcuts.ts`
  - `mobile/src/lib/runShortcut.ts`
- The shortcut privacy contract is already the right shape: device id, project
  slug, runner/model flags, labels, and small action parameters only. No paths,
  prompts, logs, images, or raw captured data.
- In-app voice classification for "load / render / open app" exists in
  `mobile/src/lib/voice/loadAppIntent.ts`, but it is only used by Yaver's own
  Vibe voice flow, not OS Siri.
- The screenshots from 2026-08-01 show `todo-rn` successfully rendered through
  the browser lane, then Fast / Full reload hit a path that reported:
  `"No mobile SDK listener or browser bundle preview is connected on this agent."`
  That is a lane-routing bug that must be fixed before Siri can be trusted.

## Product Contract

One command should mean one deterministic operation:

```text
render/open <project> [on <device>|primary] [with <mode>]
```

Resolution order:

1. If a device is named, resolve that device.
2. Otherwise use the user's primary device.
3. If runner/render roles are configured for that project, route coding to the
   runner and preview/reload to the render device.
4. Resolve project by privacy-safe slug/name, not absolute path.
5. Pick render lane from project capability and saved user preference:
   browser preview, Hermes bundle, native install, remote frame stream, or
   unsupported with a named fix route.
6. Execute exactly one render/reload operation. If coding is running, queue
   render intent and render once on `completed` / `review`.

Never store or pass arbitrary filesystem paths, prompt text, tokens, relay
hostnames, or private customer data through Siri / shortcuts.

## P0: Fix The Current Preview / Reload Mismatch

Before adding Siri, make the visible manual path solid.

Observed problem:

- The app opens `todo-rn` in browser-preview mode.
- Header buttons `Fast` / `Full` later call reload.
- The user gets a blocking alert even though a good preview is visible:
  `"No mobile SDK listener or browser bundle preview is connected on this agent."`

Implementation:

- Extract a shared lane-aware reload helper used by both:
  - `mobile/src/components/DevPreview.tsx`
  - `mobile/app/(tabs)/apps.tsx`
- Inputs: current dev status, render lane, framework, platform, mounted bundle
  state, requested mode (`fast` / `full`).
- Browser/WebView lane must never fall back into `/dev/reload-app` Hermes
  validation.
- Native/Hermes lane may use bundle fallback only when a native bundle is
  actually mounted or the user asked to open/build it.
- Reload failures should be inline status on the preview, not a blocking alert
  over the last good surface.
- Keep last good preview visible. Do not replace it with a placeholder during
  reload.

Tests:

- Unit test the reload helper for:
  - Expo browser lane: `/dev/reload`, no bundle fallback.
  - Expo Hermes lane: fast `/dev/reload`, full `/dev/reload-app`.
  - Flutter browser lane: fast/full `/dev/reload`, no Hermes fallback.
  - Failed browser reload: last good surface preserved, inline named error.
- Closed-loop mobile test against `demo/mobile/todo-rn`: open, render pixels,
  Fast reload, Full reload, still pixels.

## P1: Add A First-Class Render Intent Model

Do not make Siri call screen-specific code.

Add a shared model:

```ts
type RenderIntent = {
  project?: string;        // slug/name only
  device?: string;         // "primary", device id, or display name
  mode?: "auto" | "browser" | "hermes" | "native";
  reload?: "none" | "fast" | "full";
  source: "siri" | "deeplink" | "shortcut" | "voice" | "web" | "cli" | "mcp";
};
```

Shared behavior:

- Parse and validate intent.
- Resolve device and render route.
- Resolve project slug to agent/workspace app through existing project APIs.
- Use existing shortcut steps where possible:
  - `select-device`
  - `start-dev`
  - `open-project`
  - `hermes-reload`
- Return structured phase data:
  - `resolving_device`
  - `connecting`
  - `resolving_project`
  - `starting_preview`
  - `rendering`
  - `rendered`
  - `queued_until_task_complete`
  - `failed`

The UI surfaces render phases; they do not invent text by regexing errors.

## P2: Deep Links

Add canonical deep links:

```text
yaver://render?project=todo-rn
yaver://render?project=sfmg&device=primary
yaver://render?project=sfmg&device=magara&mode=browser
yaver://shortcut?id=<convex-shortcut-id>
https://yaver.io/render?project=todo-rn
https://yaver.io/shortcut/<id>
```

Implementation:

- Add a top-level React Native link handler that routes render links into the
  shared `RenderIntent` executor.
- Keep existing auth, pair, provision, runner-auth, pressure, and car links
  working.
- Universal links should use the existing associated domain machinery.
- For `shortcut?id=...`, fetch the user's shortcut row and execute it with
  `runShortcut`.
- If signed out, show sign-in and preserve the pending intent.
- If no primary device is set, show device picker with the command preserved.

Verification:

```bash
xcrun simctl openurl booted "yaver://render?project=todo-rn"
xcrun simctl openurl booted "yaver://shortcut?id=test"
xcrun simctl openurl booted "yaver://car-voice-coding?autostart=1"
```

Expected: all three reach React Native, log the route, and either execute or
show a named blocker.

## P3: iOS App Intents / Siri

Add native Swift App Intents under `mobile/ios/Yaver/`.

Minimum intents:

- `RenderProjectIntent`
  - title: `Render Project`
  - parameters:
    - `project`
    - `device` optional, default `primary`
    - `mode` optional, default `auto`
- `OpenYaverShortcutIntent`
  - parameter: shortcut name or id
- Optional later: `StartCarVoiceIntent` to replace the current quick-action-only
  car voice bridge.

Suggested phrases:

```text
Render ${project} in Yaver
Open ${project} in Yaver
Open ${project} on ${device} in Yaver
Render my primary Yaver app
Run ${shortcut} in Yaver
```

Intent execution should open a `yaver://render?...` or `yaver://shortcut?...`
URL instead of duplicating the JS executor in Swift. Native owns Siri exposure;
JS owns Yaver state and routing.

Implementation notes:

- Keep intents parameterized but privacy-safe. Siri should receive project
  slugs/names and device display labels, never absolute paths.
- Provide `AppShortcutsProvider` so phrases are discoverable.
- Donate recently used project/device combinations only after an explicit user
  action, not from background scans.
- App Intent result should be terse:
  - "Rendering todo-rn in Yaver."
  - "I need you to sign in to Yaver first."
  - "No primary Yaver device is set."

Tests:

- Build iOS locally.
- Run `xcrun simctl openurl` for the deep-link bridge.
- Manual device test: Shortcuts.app invokes `Render Project`.
- Manual Siri test on TestFlight: "Hey Siri, render todo-rn in Yaver."

## P4: Mobile UI For Saved Voice Shortcuts

The current Shortcuts route is hidden from the tab bar. Add a quiet entry point:

- Project detail menu: `Add Siri Shortcut`.
- Running preview menu: `Add Siri Shortcut`.
- Shortcuts screen: keep hidden route, but link to it from Settings / More.

Generated shortcut examples:

- `Open sfmg`
  - `select-device(primary)`
  - `start-dev(sfmg)`
  - browser preview or native lane per saved target
- `Open todo-rn in Yaver`
  - `select-device(primary)`
  - `start-dev(todo-rn)`
  - `open-project(todo-rn)` or browser preview per target
- `Render on Magara`
  - explicit device id for Magara
  - project slug only

## P5: Web / CLI / MCP Parity

Web:

- Add "Copy render link" and "Save as Yaver Shortcut" on project/preview
  surfaces.
- Web can invoke `https://yaver.io/render?...` and hand off to mobile via
  universal link when appropriate.

CLI:

```bash
yaver render todo-rn
yaver render sfmg --device primary
yaver render sfmg --device magara --mode browser
yaver shortcut run "Open sfmg"
```

MCP:

- Add deterministic tools:
  - `render_project`
  - `run_shortcut`
- These must not accept raw paths unless the caller is a local/full-trust MCP
  profile. Remote/hosted profiles get slug/device only.

## P6: TV / Watch / Car / Vision Parity

tvOS:

- Siri Remote dictation can produce the same `RenderIntent`.
- Render pixels should come from the render box frame stream, not an on-TV
  browser dependency.
- Fast/Full reload must call the render device, not the selected runner.

watchOS / Wear OS:

- Do not render full apps on the wrist.
- Dispatch intent to phone or remote box.
- Show one state line plus haptic:
  - "Rendering todo-rn on phone"
  - "Needs sign-in"
  - "No primary device"

Car / CarPlay:

- Voice only, no dense preview.
- Allowed actions: render/open, reload, stop, answer runner choice.
- Any ambiguous project/device must ask for confirmation.

visionOS / AR:

- RenderIntent opens a spatial preview surface.
- Same runner/render routing as mobile/web.
- Keep last good surface visible during reload.

## P7: Failure Plumbing

Every failure must carry a route to fix:

- `not_signed_in`: sign in, preserve pending intent.
- `no_primary_device`: choose/set primary.
- `device_unreachable`: show transport reason and repair route.
- `project_not_found`: show project picker filtered by spoken slug.
- `toolchain_missing`: show install button when agent offers one.
- `render_lane_unsupported`: show supported lanes.
- `reload_no_listener`: identify whether the missing listener is browser-lane
  or Hermes-lane, and route to open/build the correct listener.

No bare `"failed"` alerts for Siri-triggered flows. Siri can speak a terse
summary; the app must render the named cause and next action.

## Verification Matrix

Minimum before TestFlight:

- iOS simulator:
  - `yaver://render?project=todo-rn`
  - `yaver://render?project=sfmg&device=primary`
  - `yaver://shortcut?id=...`
  - existing auth/provision/car links still work.
- Physical iPhone TestFlight:
  - Shortcuts.app `Render Project`.
  - Siri phrase.
  - `todo-rn` browser lane renders pixels.
  - Fast reload preserves pixels.
  - Full reload preserves pixels.
- Web:
  - generated render link opens correct app state.
  - project shortcut creation stores only slug/device/flags.
- tvOS / visionOS:
  - render intent uses render device for `/dev/start`, `/dev/reload`, and frame
    stream.
- watchOS / Wear OS:
  - dispatch only, no blocked wrist UI.
- Security/privacy:
  - Convex shortcut rows contain no paths, prompts, tokens, logs, screenshots,
    relay hostnames, or private keys.
  - Remote/hosted MCP cannot call path-based render.

## Suggested Implementation Order

1. Fix mobile browser-lane Fast/Full reload mismatch.
2. Add shared `RenderIntent` executor in mobile TS.
3. Add deep-link routes and tests.
4. Add iOS App Intents that bridge to deep links.
5. Add shortcut creation UI from project/preview surfaces.
6. Add web/CLI/MCP parity.
7. Wire tvOS/watch/car/vision to the same intent model.
8. Cut TestFlight only after physical Siri + render-pixels verification.
