# N2N Web UI Watch Runtime Audit

Status: deep audit dump, 2026-07-25. Code is the source of truth; re-grep every
file/line reference before acting.

## User Goal

Yaver should feel like a remote runtime for developing any app from any surface
with AI runners. From the Web UI, on the Mac mini, a user should be able to pick
Talos/SFMG/Yaver, choose a target such as watchOS or Wear OS, build or boot it,
see the real runtime stream, send controls, see real logs, and hand the state to
Codex/Claude without guessing whether anything is happening.

This is the Snowball requirement from the `missing auth token` Web UI incident:
do not merely fix one preview URL. Make the product show the real operation,
real failure, real stream, and real logs wherever the user already looks.

## Verified Current Product Truth

The agent already has the remote-runtime target model needed for watch surfaces.
`RemoteRuntimeTarget` includes a `Surface` badge and `RemoteRuntimeSession`
returns `targetId`, `targetLabel`, `transportMode`, `frameTransport`, `runner`,
and `deviceDims` for a viewer to render and control
(`desktop/agent/remote_runtime.go:29`, `desktop/agent/remote_runtime.go:75`).

The target dispatcher already recognizes both Apple Watch Simulator and Wear OS:
`watchos-simulator` maps to an `iosSimulatorTarget` with device type
`Apple Watch`, and `android-wear` maps to an Android surface target
(`desktop/agent/remote_runtime_target.go:102`). Tests pin the Swift target list
to include `watchos-simulator` and the Kotlin target list to include
`android-wear` (`desktop/agent/remote_runtime_test.go:110`,
`desktop/agent/remote_runtime_test.go:138`).

The Web UI has a remote-runtime viewer that can negotiate WebRTC H.264 or JPEG
data-channel fallback, and it can fall back to relay JPEG polling
(`web/components/dashboard/RemoteRuntimeViewer.tsx:3`,
`web/components/dashboard/RemoteRuntimeViewer.tsx:194`). It maps pointer input
to runtime coordinates and posts tap/swipe/text/key controls through the agent
client (`web/components/dashboard/RemoteRuntimeViewer.tsx:101`,
`web/lib/agent-client.ts:4362`).

The Web UI entry point exists only inside `ProjectsView`. A project row opens a
`Native Remote Runtime` modal, loads capabilities, lists targets, creates a
session, and embeds `RemoteRuntimeViewer`
(`web/components/dashboard/ProjectsView.tsx:189`,
`web/components/dashboard/ProjectsView.tsx:544`,
`web/components/dashboard/ProjectsView.tsx:620`).

The watch apps are voice/session clients, not visual runtime viewers. watchOS
and Wear OS standalone clients drive `/runner/session/turn`, map menu choices,
and summarize pane output for the wrist
(`watch/YaverWatch/SessionClient.swift:1`,
`wear/app/src/main/kotlin/io/yaver/wear/SessionClient.kt:15`). That is correct
for "develop from watch"; it is not the same as "test a watchOS app from Web UI."

The runner-facing MCP bridge for runtime operation exists. The remote-runtime
MCP shim proxies `runtime_*` verbs to the local HTTP runtime endpoints with the
owner bearer token (`desktop/agent/remote_runtime_mcp.go:3`). This gives an AI
runner a path to observe and operate the app if the UI gives it the session
handle and visible state.

Mobile already has the tmux attach product shape Web UI should copy. The mobile
shell supports three PTY targets: a raw shell, a stable runner tmux session, and
an arbitrary named tmux session (`mobile/app/shell.tsx:38`). Its deep link
`/shell?session=<tmux>` opens straight onto that named `/ws/runner` session
(`mobile/app/shell.tsx:94`). Runner chips attach to stable `yaver-<runner>`
tmux sessions, and leaving the screen only drops the socket; the tmux process
continues (`mobile/app/shell.tsx:208`). Web UI currently has `WebShellModal`,
which opens the generic terminal/runner launcher over the agent PTY path, but
named tmux attach/adopt/list parity is not yet part of the Web UI runtime
workflow (`web/components/dashboard/WebShellModal.tsx:3`).

The new Web UI bundle-preview fix proved three important false greens in the
real Mac mini loop: build success can be lost as a transport error, a dev bundle
can be present but unusable without its signature, and a signed relay response
can still fail browser decoding when compression headers are wrong. The product
must therefore preflight the actual URL/frame/log stream it will show, not just
trust "running" status.

## Product Gap

The low-level primitives are present, but the Web UI does not yet expose an n2n
runtime surface. Today the user has to know that "Projects -> Remote Runtime ->
Create Session" is the way to test watchOS/Wear. That is not good enough for
Yaver's stated job.

The missing product shape is a first-class Runtime Lab:

- project picker scoped to a connected machine
- target matrix by surface: web, phone, tablet, watch, TV, car, vision/XR,
  desktop
- platform picker by surface: watchOS and Wear OS for watch; tvOS and Android
  TV for TV; iOS/Android for phone/tablet
- capability state from the real agent, including disabled reasons
- build/boot/launch buttons that run the real operation
- stream panel with transport state and frame freshness
- control panel specific to the surface
- real log streams for build, runtime, relay, and runner
- runner handoff that includes project, target, session id, current frame, and
  the relevant log tail
- chat-triggered routing: a user should be able to type "test Yaver watchOS on
  the Mac mini" or "open Talos Wear from Web UI" in dashboard chat, and the
  product should resolve the project/target, start the operation, and route the
  UI into the relevant Runtime Lab/Webview view automatically
- tmux session attach parity with mobile: Web UI should list/adopt/open named
  tmux sessions, attach to runner panes, and let the user vibe from an existing
  tmux session without local SSH

Without that, users feel stuck because the UI reports partial status while the
operation that matters may still be impossible.

## Chat As The Command Surface

Dashboard chat must become a first-class command surface for n2n runtime work,
not only a task composer. A natural-language request should route to the same
capability graph the buttons use.

Examples:

- "open Talos for watchOS" -> resolve Talos, infer `surface=watch` and
  `platform=ios`, select `watchos-simulator`, route to Runtime Lab, create or
  attach the watch session, fetch the first frame, and show the real logs.
- "test Yaver watchOS from this Mac mini" -> resolve project `yaver`, surface
  `watch`, platform `ios`, target `watchos-simulator`, open Runtime Lab, create
  or attach the session, show stream and logs.
- "open Talos Wear app" -> resolve project `talos`, surface `watch`, platform
  `android`, target `android-wear`, open Runtime Lab and begin boot/frame
  preflight.
- "show SFMG web preview" -> route to the Webview/Web Reload path, start the web
  bundle/dev server path, preflight the signed URL, and show logs.
- "hand this watch session to Codex" -> attach runner context to the active
  runtime session and include frame/log tail.

The chat result must not be a text-only answer that says what the user should
click. It should perform the safe, idempotent steps and navigate/render the
right surface. When a destructive or expensive step is needed, chat should park
an inline confirmation and keep the Runtime Lab visible with the pending reason.

Implementation contract:

- add a small intent resolver for project, surface, platform, target, action,
  and render view; do not make the runner guess paths the dashboard already has
- route Web UI state by explicit params such as `tab=runtime-lab`,
  `projectPath`, `surface`, `platform`, `targetId`, `sessionId`
- if the request maps to web preview, route to the Webview/Web Reload surface;
  if it maps to native/watch/tv/vision/desktop, route to Runtime Lab
- every chat-triggered operation writes to the same visible runtime console as
  button-triggered operations
- chat should surface the same disabled-target reason the capability endpoint
  returned, not rewrite it into vague advice
- runner handoff from chat should pass the active session id; runners should not
  start a parallel runtime unless the user asks for a new one
- short phrasing is part of the contract: "open Talos for watchOS", "run SFMG on
  Wear", "show Yaver TV", and "open this for web" must work without requiring
  the user to know target IDs or which dashboard tab owns the surface
- tmux phrasing is part of the contract: "attach to the Talos Codex tmux",
  "vibe from the existing n2n session", "open the running Claude session",
  "detach and keep it running", and "close that tmux" must route to the terminal
  surface with the selected tmux session and the right safety semantics

## Web UI Tmux Attach Parity

Yaver's AI-runner model is tmux-backed. Web UI needs the same attach surface
mobile has, otherwise a browser user can start runtime work but cannot reliably
observe or steer the long-running runner session that owns it.

Current mobile contract to preserve:

- raw shell target opens `/ws/terminal`
- runner target opens `/ws/runner?runner=<id>&name=yaver-<runner>`
- arbitrary tmux target opens `/ws/runner?name=<sessionName>`
- deep link `/shell?session=<tmux>` attaches directly to that named session
- closing the view detaches the socket; it does not kill tmux
- destructive close is explicit and warns that it kills the session

Required Web UI behavior:

- list live tmux sessions with names, panes, active runner classification, task
  correlation, last activity, and a scrollback preview
- open any named tmux session in an xterm-backed modal/page, not only a fresh
  shell
- support runner chips for stable `yaver-codex`, `yaver-claude`, and
  `yaver-opencode` sessions
- support attach, detach, adopt, close-pane, and close-session actions matching
  mobile's semantics
- detach means close the browser WebSocket and keep tmux running
- close means terminate only the named pane/session after explicit confirmation
- route task cards, runtime sessions, and chat results to the same terminal view
  with an explicit `session=<tmux>` state param
- show connection state, WebSocket state, last byte time, resize state, and
  close/error reasons so a terminal does not become another silent spinner
- integrate runner keeper state: when the user attaches, set mode
  `user-driven`; on detach, let the user choose `auto` or `off`

Chat examples:

- "attach to Talos Codex tmux" -> find the Talos task/project session, route to
  terminal with `session=<name>`, set runner keeper mode `user-driven`, and show
  the live pane.
- "vibe from the existing n2n session" -> resolve the active n2n tmux session,
  attach the Web UI terminal, and keep the Runtime Lab/session context visible.
- "resume the Yaver mobile runner" -> open the existing tmux if present; if not,
  create or attach the stable `yaver-codex` or selected runner session and
  record that it was created.
- "detach and keep it running" -> close the browser WebSocket, set keeper mode
  `auto` or user-selected `off`, and leave the session alive.
- "close that tmux" -> require explicit confirmation, then terminate only the
  named tmux session or pane the user selected.

Closed-loop tmux tests:

- stub or real agent reports two tmux sessions; Web UI renders both names and
  previews
- chat command "attach to Talos Codex tmux" routes to terminal state with the
  expected `session` parameter
- WebSocket URL for arbitrary session uses `/ws/runner?name=<sessionName>`, not
  `/ws/terminal`
- attach calls runner keeper attach/user-driven; detach can flip to auto/off
- closing the modal without destructive confirmation does not kill tmux
- stale/no-output terminal shows last byte time and a reconnect action

## WatchOS/Wear Specific Gaps

`watchos-simulator` can boot and screenshot through the shared iOS simulator
driver, but Web UI does not present it as "watchOS" in a dedicated Runtime Lab.
It is buried in a modal and competes with every other target.

Apple Watch controls are under-specified. Generic tap/text may work, but Digital
Crown and watch-specific affordances are not in the Web UI. The agent has
actionable iOS key errors rather than a real crown bridge. Web UI should expose
surface controls only when the runtime reports support, and show a direct
install/probe reason otherwise.

`android-wear` has a better control baseline because the agent maps D-pad and
`crown_up`/`crown_down` to Android keycodes
(`desktop/agent/remote_runtime_webrtc.go:793`). Web UI currently only shows the
full Android hardware key cluster for `android-emulator`, not for
`android-wear`, `android-tv`, or the other Android surface IDs.

The watch apps themselves are session-turn clients. Testing Yaver's own
watchOS/Wear apps from Web UI needs two paths:

- app-under-test path: build/boot/launch the watch app in a watchOS/Wear runtime
  and stream it in Web UI
- client-surface path: simulate or use the watch app as a command surface that
  sends `/runner/session/turn`, with Web UI showing the received turn and logs

Those paths should be explicitly separated so users do not confuse "drive from
watch" with "preview a watch app."

## Logs And Stuck-State Requirements

The Web UI must show real logs, not synthetic "working" states. For every
runtime session, the visible console should merge:

- build/deploy output for the selected project and target
- remote-runtime lifecycle events: capabilities, create, attach, boot, launch,
  WebRTC/relay negotiation, frame pump, control errors, close
- `/dev/events` style project logs when a dev server or bundle is involved
- runner logs/session-turn status when AI is operating the app
- transport errors from the browser-facing proxy, including 401/403/5xx bodies

Every stream needs visible state: opening, open, last event time, closed, error,
and retry. A green panel with no fresh frames or logs is a false green.

The Web UI should preflight the exact thing it will render:

- iframe/web bundle: fetch the signed URL that will be loaded
- remote runtime: create or attach session, fetch one real frame, then negotiate
  stream
- watch/Wear client mode: post a bounded `/runner/session/turn` probe against a
  test session or a mocked safe session and show the response

## Closed-Loop Test Matrix

The minimum closed-loop suite for the Mac mini should run from Web UI contracts,
not only Go unit tests.

For each project `talos`, `sfmg`, and `yaver`:

- Web bundle path: start/build/preflight signed preview URL, iframe renders
  HTML, `/dev/events` stream opens, logs contain real build phases.
- Native runtime path: load `/remote-runtime/capabilities` and assert enabled
  targets are explicit and disabled targets include actionable reasons.
- Watch target path: for Swift/iOS-capable projects, create
  `watchos-simulator`, fetch a real frame, negotiate the viewer transport, and
  issue one supported control or verify the unsupported reason is visible.
- Wear target path: for Kotlin/Flutter/Android-capable projects, create
  `android-wear`, fetch a real frame, negotiate stream, send `crown_down` or a
  D-pad key, then fetch another frame.
- Runner handoff path: call the runtime MCP frame/control path or `develop_for`
  equivalent with the session id and assert the runner can see an image result
  plus log tail.
- Tmux attach path: list live tmux sessions, attach to an existing session, see
  real pane output, detach without killing it, and close only after explicit
  confirmation.

Pass criteria:

- no raw JSON error is displayed in an iframe or stream surface
- no status says ready unless the exact render path was fetched successfully
- every failure includes the failing operation, endpoint class, status, and
  next action
- console shows live stream state and real latest log line
- browser, mobile, and eventual desktop surfaces see the same session id and
  target labels
- tmux attach/detach/close semantics match mobile and never destroy a session on
  ordinary modal close/navigation

## Web UI Implementation Slices

1. Add a `RuntimeLabView` dashboard tab backed by the existing
   `agentClient.getRemoteRuntimeCapabilities`, `startRemoteRuntimeSession`,
   `fetchRemoteRuntimeFrame`, `createRemoteRuntimeWebRTCAnswer`, and
   `sendRemoteRuntimeControl` methods.

2. Promote target selection from a project-row modal to a matrix:
   `surface -> platform -> targetId`. Watch should show `watchOS Simulator` and
   `Wear OS Emulator` as first-class choices.

3. Add surface-specific controls:
   watchOS: tap, text, install/probe status for crown support.
   Wear OS: tap, D-pad, `crown_up`, `crown_down`, back, home.
   TV: D-pad/select/menu/play-pause where target supports it.

4. Add a session console that subscribes to real agent events and also records
   browser-side transport states. The console should never be empty while an
   operation is in progress; if no server event has arrived, show the client
   operation currently waiting.

5. Add a "Hand To Runner" action that includes `{workDir, framework, surface,
   platform, targetId, sessionId}` and captures a current frame. The runner
   should not need to rediscover what the UI already knows.

6. Add chat intents that route into Runtime Lab/Webview with URL/search state
   and visible console entries. The chat path and button path must call the same
   operation helpers so they cannot drift.

7. Add Web UI tmux attach parity: session list, named attach route, stable
   runner chips, adopt/detach/close actions, and runner keeper integration.

8. Add Playwright/Node closed-loop tests against a real or stubbed agent route
   for the Web UI contracts: target matrix renders watch targets, disabled
   reasons are visible, frame preflight failure blocks a green status, stream
   status transitions are visible, control buttons send the expected JSON, and
   chat requests navigate to the expected surface with the expected target.
   Include tmux attach tests for named session routing and non-destructive close.

## Desktop App Requirement

The desktop app should eventually host the same Runtime Lab surface. It should
not invent a second runtime model. The shared contract is:

- same target IDs as the agent (`watchos-simulator`, `android-wear`, etc.)
- same session schema
- same visible log stream states
- same control lease semantics
- same runner handoff payload
- same tmux attach/detach/close semantics as Web UI and mobile

The desktop app can render through native WebView/Electron/SwiftUI, but it must
not hide the runtime operation behind a generic "build" or "preview" button.
The product promise is remote runtime, so the user has to see which runtime is
booting, which transport is streaming, which runner is attached, and which logs
are fresh.

## Immediate Next Work

The preview auth/log fix should be pushed first because it removes a real Web UI
blocker found on the Mac mini. The next product slice should be the Runtime Lab
entry point in Web UI, starting with read-only capabilities plus session create
for `watchos-simulator` and `android-wear`, then adding log merge and controls.

Do not claim the n2n watch surface is product-complete until a Web UI test can
create a watch runtime session, fetch a frame, show a fresh log stream, and hand
that exact session to a runner.
