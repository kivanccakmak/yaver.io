# Web UI Deep Audit — Chat + Vibing (and the Electron GUI decision)

Date: 2026-08-12. Scope: `web/app/dashboard/page.tsx` (chat tab), the Vibing
surfaces (`RuntimeLabView`, `VibeCodingView`, `VibePreviewView`, `PreviewPane`,
`WebReloadView`, `RemoteRuntimeViewer`), the streaming libs
(`taskStreamWithRecovery`, `taskStreamRecovery`, `streamBuffer`,
`command-events`, `agent-client`), against the mobile app and the agent-side
contract in `desktop/agent/*.go`. Companion to the Electron GUI scaffold in
`electron/`. Every claim below was verified by reading the code; file:line
citations are from HEAD.

---

## 1. Chat section — architecture

**Streaming pipeline (agent → web):**
- One endpoint, `GET /tasks/{id}/output`, serves two independent SSE lanes on
  one stream: the groomed transcript (`?since=<bytes>` → `{type:"output"}` +
  `{type:"done"}`) and the raw runner stdout (`?rawSince=<bytes>` →
  `{type:"raw"}` / `{type:"raw_replay"}`), capped at 512 KB on the agent
  (`desktop/agent/tasks.go:65-71`).
- Web opens it with GET+fetch (`agent-client.ts:3581-3585`), tracks the byte
  cursor and a `sawDone` flag, and wires recovery through
  `taskStreamWithRecovery` (bounded backoff 1s→15s, give-up after 5 with a
  Reattach route — `web/lib/taskStreamRecovery.ts:53-64`).
- The web chat subscribes **only while `running || queued`** and **never
  requests the raw lane** (`rawSince` only appended when `> 0`,
  `agent-client.ts:3561`).
- Composer send: new task → `POST /tasks`; mid-run follow-up →
  `POST /tasks/{id}/continue` **immediately**; the agent queues follow-ups
  server-side (`page.tsx:2635-2641`). The web's *local* `pendingFollowUps`
  queue is dead (see §7.1).

**Rendering:** a single growing assistant bubble per task, capped at 8000
lines, with the console look approximated via `AnsiConsoleText` over the
*groomed* output when `hasConsoleMarkup` matches (`page.tsx:953-961`).

## 2. Chat — parity divergences vs mobile (highest-value)

| Concern | Web | Mobile | Verdict |
|---|---|---|---|
| Raw opencode console lane | **Absent** — comment admits "nothing on this page consumes it" (`page.tsx:997-1004`) | `LiveConsoleSection` consumes raw lane with 512 KB tail, live/idle dot, byte counter, per-task reset, reattach resume (`tasks.tsx:3081-3106, 3253`) | Web missing a lane mobile has |
| Command cards | **Absent in chat** — `CommandCard.tsx` shipped only to `PreviewPane` (build commands); the chat `onEvent` never calls `isCommandEvent` | `CommandsPanel` fed by `command_start/output/end` SSE (`tasks.tsx:3209-3216, 7650`) | Web missing a lane mobile has |
| `runtime_render_requested` gating | **Dropped** — no branch in `onEvent` (`page.tsx:1740-1762`) | Queued, rendered exactly once at terminal state with a named skip notice (`tasks.tsx:3217-3224, 3383-3403`) | Web violates the AGENTS.md render contract |
| Turn liveness | "thinking…" ellipsis, no elapsed/last-output age (`page.tsx:4564-4577`); `runnerTurnHeartbeat` used only by RuntimeLabView | `PhaseStatusLine` with elapsed + "still working 12s" (`tasks.tsx:847-937`) | Web has no stuck-turn detection |
| Finished-task follow-up | `continueTask` on the completed parent (in-place `--resume`) | Forks to a child task with context handoff (`tasks.tsx:4727-4736, 4786`) | Behavioral divergence |
| Send connection gate | **None** — on a flapped relay the POST hangs up to 30s, input cleared, button stuck on "…" (`page.tsx:2631-2930`) | Refuses when `connectionStatus !== "connected"` and keeps the text (`tasks.tsx:4526-4539`) | Web can lose a message mobile cannot |
| `resume.full` (task re-created) | Passes **no** `onResumeFull` → merged/duplicated transcript in the bubble | Clears per-task buffer and output (`tasks.tsx:3197-3206`) | Web renders a duplicated transcript |
| Final-status propagation | `done` only closes the question card; status arrives via 3s poller (~3s lag, `page.tsx:1803-1834`) | `onDone` updates status + `fetchTasks()` immediately (`tasks.tsx:3176-3187`) | ~3s composer lag on web |
| SSE transport | GET + fetch, `?token=` in URL for EventSource lanes (`agent-client.ts:6135-6164`) | POST + XHR with **headers**, no token in URL (`quic.ts:3069-3076, 3166-3169`) | Web-only token-in-URL exposure |

Parity tests exist for task-stream recovery only; the `command-events` twins
(web vs mobile) and the two `AnsiConsoleText` copies have **no parity pin**.

## 3. Vibing — architecture (three loops, not one)

- **Loop A — dev server → live iframe.** `POST /dev/start` → `/dev/*` proxy
  (unauthenticated by design, `httpserver.go:1049`) → iframe; `/dev/events`
  SSE drives progress/ready (`RuntimeLabView.tsx:1933-1997`). Reload via
  `POST /dev/reload` / `POST /dev/build-native`.
- **Loop B — agent-captured frames.** `/vibing/preview/*` — JPEG stills pulled
  per `frame` SSE event, content-addressed (`vibe_preview.go:132`); **the web
  viewer for this loop (`VibePreviewView`) is orphaned** (see §7.2).
- **Loop C — remote runtime.** `/remote-runtime/sessions/*` — WebRTC
  DataChannel JPEG chunks with an HTTP JPEG-poll fallback and an 8s watchdog
  (`RemoteRuntimeViewer.tsx:301-366`).

**Render gating (the AGENTS.md contract) exists on the "runtime" tab only:**
`taskStatusAllowsRender` (`RuntimeLabView.tsx:796-798`) gates the
auto-render effect (`3014-3071`), `runtime_render_requested` intents are
stored, not executed (`2201-2210`), and `reloadWebPreview` queues while the
runner is coding (`2902-2907`). But **`PreviewPane` and `VibeCodingView`
have no post-task render at all** — no `runtime_render_requested` handling, no
terminal-state effect. The iframe there refreshes only on the agent's raw
`/dev/events` `reload`/`ready` frame (`PreviewPane.tsx:714-720`), which is not
a task-completion signal. **Three web surfaces disagree on whether a finished
task refreshes the preview.**

## 4. Vibing — pixels vs status (claims of "rendered" without proof)

- **"preview live" pill = `devStatus?.running`** (`VibeCodingView.tsx:2364`) —
  an HTTP status, not a pixel. A compile-failed-but-listening server reports
  `running=true`; the pill stays green over a blank iframe (the code's own
  compile-failure comments admit this, `RuntimeLabView.tsx:3689-3692`).
- **Overlay lift = iframe `onLoad` + a hard-coded 900 ms timer**
  (`RuntimeLabView.tsx:3762, 3783`; same trick in `WebPreviewFrame.tsx:352`).
  `onLoad` fires before the JS bundle runs or anything paints.
- **`probePreviewUrl` "ok" = HTTP 200 + no "no dev server" text**
  (`RuntimeLabView.tsx:863-875`).
- **`previewPhaseTitle` is called with a null probe on web**
  (`PreviewPane.tsx:1881`) — the paint-probe branches are dead on web by
  construction. Mobile injects `PREVIEW_READY_PREDICATE` (a real DOM paint
  classifier, `previewReadyScript.ts:57-80`) and lifts the overlay only on
  `mount_has_visible_content` / `flutter_engine_attached` /
  `plain_body_content`. **The web has no paint evidence anywhere.**

## 5. Failure plumbing — gaps (named signal + route-to-fix, or prose/spinner?)

Well-plumbed on web: typed start refusals (`preview.session_active`,
`preview.target_unreachable` reason codes) with one-tap routes
(`VibePreviewView.tsx:120-141`), compile-failure cards replacing the blank
iframe (`PreviewPane.tsx:804-807`), missing-toolchain install streams
(`PreviewPane.tsx:2072-2131`), deterministic probe-failure routes
(`RuntimeLabView.tsx:3319-3403`), and dead-SSE relay repair
(`PreviewPane.tsx:538-574`).

Gaps — no named signal, prose/spinner only:
- **Capture dead:** the web frame fetch silently swallows failures
  (`VibePreviewView.tsx:84-86`); no watchdog for "session started, no frame
  arrived" — the UI can say "waiting for the first frame…" forever
  (`VibePreviewView.tsx:550-564`). No reason code, no route.
- **WebRTC stall:** named fallback note exists, but the HTTP pump's per-frame
  failure is just a viewer note; no failure-streak → route
  (`RemoteRuntimeViewer.tsx:280-282`).
- **`reload.preview_worker.offline`** is consumed only by ConnectivityView;
  nothing in the vibing/preview views branches on it.

Chat-side silent swallows: `page.tsx:2680-2693` (project/MCP memory saves),
`2722-2729` (placement profile), `2804-2818, 2874` (cloud activation), and the
review "Complete" button `onClick` has **no try/catch** (`page.tsx:4447-4460`)
— a rejecting `completeTask` lands only in the generic RawFailureBanner with
the operation context lost.

## 6. Security findings

1. **OSC-8 `javascript:` href XSS (web-only).** `_core/ansi.ts:99-131`
   extracts `\x1b]8;;<url>\x07` verbatim with no scheme check;
   `AnsiConsoleText.tsx:72-78` renders it as `<a href={t.href} ...>` — React
   does not sanitize `href`. A prompt-injected OSC-8 link in runner stdout
   executes script in the dashboard origin. Mobile's twin renders no `<a>` at
   all, so this is web-only. **Fix: allowlist `https:`/`http:`/`mailto:` in
   the tokenizer or the renderer.**
2. **Bearer token in SSE URLs.** `appendStreamAuth` puts `?token=<jwt>` and
   `?__rp=<relay password>` into EventSource URLs (`agent-client.ts:6135-6164`).
   The relay strips `__rp`, but the JWT reaches the agent and lands in its
   access log (`httpserver.go:2624`) and browser history for direct connects.
   AGENTS.md's "never a token in a URL" is violated on web. Mobile uses
   headers. **In the Electron GUI, fix this in the shell:** intercept the
   requests and move the token into the `Authorization` header.
3. **`/dev/` + `/dev-web/` unauthenticated by design** (`httpserver.go:1049,
   1057`) — necessary for iframes; combined with
   `sandbox="allow-scripts allow-same-origin allow-forms allow-popups
   allow-modals"` (`WebPreviewFrame.tsx:350`), the preview page runs
   same-origin with the dashboard when served through the `/d/<id>/dev/`
   proxy and can read `yaver_auth_token`. Low practical risk (the content is
   the user's own app) but the sandbox provides no isolation. The
   `/d/<deviceId>/` proxy correctly refuses `Access-Control-Allow-Credentials`
   (`route.ts:23-36`).
4. **F3 secret answers** are relayed to every device over SSE
   (`agent-client.ts:3518-3519`); the web client discards them, but the
   daemon-side relay of secrets to peers should be re-verified against the
   `yaver_ask_user` "not echoed" contract.

## 7. Stale code / dead weight

1. **`taskOutputSuggestsRender` is dead code** (`RuntimeLabView.tsx:790-794`,
   defined once, zero callers repo-wide) — and it encodes exactly the
   forbidden rule ("infer reload permission from output text" via regex on
   `files? changed|saved|patched|updated`) that AGENTS.md's cross-surface
   render contract bans. A future refactor that "reuses" it reintroduces the
   bug. **Delete it.**
2. **`VibePreviewView` (615 lines) is orphaned.** `"vibe-preview"` is a
   declared tab id (`page.tsx:160`) but the component is never imported or
   rendered. Its clip-panel logic was lifted into WorkspaceShell. **Either
   mount it or delete it.**
3. **Dead local follow-up queue.** `pendingFollowUps` (`page.tsx:1086`) is
   never pushed to — only reset to `[]`. The comment at `1078-1085` ("we
   mirror what claude-code/codex/opencode do interactively: keep typing, queue
   up, dispatch on completion") contradicts the comment at `2635-2641`
   ("Mid-run sends go STRAIGHT to the agent") and the code follows the second.
   The composer's `queuedCount`/`Queue after current run (+N)` label
   (`5254-5273`) is dead UI reading an always-empty array; the agent's real
   queue count is never shown on web (mobile shows it).
4. **Duplicated logic, no parity pins:** `inferTaskPlacementKind` is
   byte-identical in `page.tsx:197-204` and `VibeCodingView.tsx:92-99`;
   `runnerAuthIssue` re-implements `runnerChipState.ts:146-154`;
   `stripAnsi` duplicated web/mobile (separate from the shared tokenizer);
   `AnsiConsoleText` is a copy-paste twin with only comment-level sync; the
   keyword→percent progress map exists in `PreviewPane.tsx:516-532` and again
   in mobile `apps.tsx` ("mirrors" comment is the only sync).
5. **Three independent "recovery/repair" implementations** (PreviewPane's
   pkill+rm-rf repair, WebReloadView's Reconnect & Fix, the relay-password
   auto-repair) — overlapping advisory surfaces.
6. **`taskStatusAllowsRender` policy is inline + untested on web**, while
   mobile has a pure, tested `planPostTaskRender()` module
   (`mobile/src/lib/previewReload.ts:99-152`). The same policy should be a
   shared/tested module — the GUI will need it.

## 8. LESS-IS-MORE violations (both sections)

- **VibeCodingView header pill wall:** machine + project + runner + model +
  "preview live" pills (`2360-2364`), device pills for every machine beneath
  (`2402-2416`).
- **ConsoleStatusHeader instrumentation strip:** agent state + SSE state +
  attempt/event counts + "last Ns ago" + dev port + heartbeat beat# + uptime +
  pid + pid-alive + idle + per-topic progress bars (`PreviewPane.tsx:2350-2453`),
  re-rendering at 1 Hz (`473-477`).
- **Two recovery banners + a stop-confirmation + relay repair on one surface**
  (WebReloadView `1404-1425, 1506+`; PreviewPane `1874-1925, 881-1030`).
- **Chat:** runner-auth rendered twice with two Sign-in buttons
  (`4510-4524` and `5126-5139`); task status shown three ways in the header
  (pulsing dot + status text + runner chip with its own dot, `4431-4444`);
  composer shows five chips before the input (`4646-4719`); three amber
  banners can stack (`4474-4524`).
- CoVibeCard is the good counter-example (one card, no per-surface grid).

## 9. What this means for the Electron GUI (decision inputs)

1. **Load target:** `https://yaver.io/dashboard` (verified 200) with a
   `localhost:3000` dev fallback — the GUI is a shell, not a fork. The web app
   now hides marketing chrome (header nav, footer) on the auth flow and app
   surfaces (`web/lib/app-surface.ts`), so the GUI's login page is the bare
   auth card and the dashboard stays `dashboard-mode` clean.
2. **Fix the token-in-URL finding in the shell, not the web app:** intercept
   network requests in the main process, strip `?token=`/`?__rp=` from
   EventSource/stream URLs, and re-inject them as `Authorization` /
   `X-Relay-Password` headers. Electron can do what EventSource cannot. This
   removes the finding's exposure for GUI users immediately.
3. **Render-proof is a web-app problem the GUI inherits** — the 900 ms
   onLoad timer and the green-over-blank pill are in the web app. The GUI
   should surface (not hide) `StreamHealthNotice`/`RawFailureBanner` and
   should not add its own "connected" status chrome (LESS IS MORE).
4. **Sandbox + isolation in the shell:** `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true`, allowlist navigation, no
   `allow-same-origin`-with-scripts framing beyond what the app already does.
5. **Native value-adds the web cannot provide:** tray with device status, task
   completion notifications, `yaver://` deep links (`?tab=chat|runtime`), Cmd+J
   search, background "keep alive" while closed, and a window that survives
   relay flapping (reload button = the existing Reattach route).
6. **The chat raw-console lane, command cards, and render gating** are the
   three parity gaps users hit daily; the GUI shell should land with the
   dashboard, and these are the web-app fixes to schedule next
   (delete `taskOutputSuggestsRender`, mount-or-delete `VibePreviewView`,
   fix the OSC-8 href, kill the dead queue + its lying copy).

---

### Verified-claim appendix

| Claim | Verification |
|---|---|
| `taskOutputSuggestsRender` never called | `rg taskOutputSuggestsRender web` → 1 hit, the definition at RuntimeLabView.tsx:790 |
| OSC-8 href unsanitized | `_core/ansi.ts:99` (regex, no scheme check) + `AnsiConsoleText.tsx:72-78` (`<a href={t.href}>`) |
| `?token=` in stream URLs | `agent-client.ts:6135-6164` `appendStreamAuth` |
| `pendingFollowUps` never pushed | `rg setPendingFollowUps page.tsx` → only `[]` resets (2473, 3007, 3063) + slice (3021) |
| `VibePreviewView` orphaned | `rg VibePreviewView web` → only its own file + two comments |
| Dashboard reachable | `curl -w %{http_code} https://yaver.io/dashboard` → 200 |
