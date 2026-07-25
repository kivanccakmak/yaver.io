# Project Render Capability Audit - 2026-07-25

## Finding

The Projects surfaces were mixing three different concepts:

- repo discovery: a root like `yaver.io` is the work scope for agents, git, env, and whole-stack vibing.
- app discovery: child paths such as `mobile/`, `web/`, and `backend/` are runnable targets.
- render capability: the web dashboard can render browser previews and streamed simulators, while the Yaver mobile app can also run native phone-container lanes such as Hermes bundle push.

That mismatch produced two visible failures:

- `yaver.io` could be discovered as a repo but not shown as a normal project card in the mobile Projects list.
- the browser dashboard showed `Hermes` for RN/Expo rows even though Hermes is a mobile-app/native-container lane, not a browser-renderable Web UI lane.

## Code Path

- Agent `/projects`: `desktop/agent/httpserver.go`
- Mobile Projects tab: `mobile/app/(tabs)/apps.tsx`
- Web dashboard Projects view: `web/components/dashboard/ProjectsView.tsx`
- Web agent client project type: `web/lib/agent-client.ts`

## Capability Model

Phone UI can expose:

- `Hermes` for Expo/React Native when the Yaver mobile container can receive a bundle.
- `Web UI` when the project has a browser/web target.
- `Simulator (WebRTC)` when a native runtime can be streamed.

Web UI can expose:

- `Web UI` for browser/WebView-capable projects: Next/Vite/React, Expo web, React Native web, Flutter web.
- `Browser over WebRTC` when the Mac/box launches Chrome and streams that browser back into the dashboard.
- `Simulator (WebRTC)` for native mobile stacks: Expo, React Native, Flutter, Swift, Kotlin, or explicit `native-webrtc` mode.
- no `Hermes` button, because the browser dashboard cannot host the mobile Hermes bundle lane directly.

## Product Fix

- Treat `yaver.workspace.yaml`, `yaver.workspace.yml`, `versions.json`, and `scripts/deploy-*.sh` as project signals in `/projects`.
- Merge repo roots into the mobile Projects list as normal searchable/filterable project cards.
- Search and category filters now use stack/surface metadata, not only the legacy single `framework` field.
- Web dashboard render buttons now come from browser-vs-remote capability checks instead of the mobile execution mode label.
- Runtime Lab groups browser, simulator, Android container, physical device, and advanced/unavailable targets so Flutter/RN do not show watch/TV/XR as the default path.

## Follow-up Finding

The first fix still depended too much on `/projects` being current. On a real
Mac mini, `/repos/list` could see `~/Workspace/yaver.io` while `/projects`
still returned only framework/app rows, so the dashboard kept hiding the repo
root until the agent binary itself was updated.

The browser render lane also reused the unsigned `/dev/web-bundle/` fallback in
one path. That made the iframe fail with `dev bundle URL must be signed; mint
via /dev/build-native or /dev/web-bundle/info` instead of routing Expo/RN
through `POST /dev/build-native target=web-js-bundle` and using the signed URL
from the response.

Runtime Lab had a separate focus problem: it placed tmux sessions in the right
rail, so a render-lane screen looked like an agent-session manager.

## Follow-up Fix

- Web dashboard now merges `/projects` with live `/repos/list` rows and pins
  `yaver.io` repo roots first, so a Cloudflare web deploy can show the repo
  immediately even before the Mac mini agent binary is reinstalled.
- Mobile repo inventory now uses `/repos/list` directly for whole-repo cards.
- Project Detail is render-lane first: Web UI, WebRTC targets, stack/platforms,
  then git metadata. Backend/services/domains/deploy noise is gone from this
  screen.
- Expo/RN browser previews build a static web bundle and render the signed
  `/dev/web-bundle/?...` URL. Flutter stays on its normal web dev-server lane.
- Runtime Lab no longer renders tmux sessions in the side rail; the side rail is
  render activity only, while chat/agent sessions stay in Vibing.
- Dark mode now uses a real dark surface instead of hard-coded light gray cards
  on a dark page.
