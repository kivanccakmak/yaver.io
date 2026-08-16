# sfmg Mobile Browser Preview Black Screen — 2026-07-25

## Trigger

The phone screen recording
`/Users/kivanccakmak/Downloads/ScreenRecording_07-25-2026 21-59-28_1.MP4`
shows the mobile app connected to the Mac mini, filtering Projects to `Mobile`,
then selecting `sfmg` (`Expo`, workDir `/Users/pokayoke/Workspace/sfmg`).

The preview opens immediately into a full-screen modal titled `sfmg`. The header
has Back, expand, refresh, and red stop controls. The content area stays pure
black for the rest of the recording. No build output, no current URL, no server
state, no error, and no log tail appears.

The still screenshot
`/Users/kivanccakmak/Downloads/Ekran Resmi 2026-07-25 - 22.00.34.png`
captures the same state: a visible Yaver preview shell over a black WebView.

This is the Browser Reload / browser-lane path, not a Hermes native bundle push.

## Scope

Relevant code paths in the current repo:

- Mobile Projects browser preview modal: `mobile/app/(tabs)/apps.tsx`
- Shared preview readiness probe: `mobile/src/lib/previewReadyScript.ts`
- Shared React Native SSE client: `mobile/src/lib/sseClient.ts`
- Secondary preview implementation: `mobile/src/components/DevPreview.tsx`
- Mobile agent client URL construction: `mobile/src/lib/quic.ts`
- Agent dev server lifecycle and Expo web sibling: `desktop/agent/devserver.go`
- Agent HTTP routes and `/dev-web/` proxy: `desktop/agent/devserver_http.go`,
  `desktop/agent/httpserver.go`
- Browser-lane doctor probe: `desktop/agent/doctor_browser_lane.go`

The screenshot header matches `mobile/app/(tabs)/apps.tsx`, not
`mobile/src/components/DevPreview.tsx` and not `mobile/app/(tabs)/project.tsx`.
That matters because there have historically been multiple preview
implementations with drift.

## What The User Actually Saw

The visible UI proves these things:

1. The phone is inside Yaver's Projects preview shell.
2. The modal opened and accepted the project title.
3. The preview WebView either loaded a black/empty document, or the overlay that
   should have explained startup was hidden too early.
4. The user-facing state machine did not report the URL, the selected lane, the
   active port, the current process, the last `/dev/events` frame, or any
   terminal build/runtime error.

The UI does not prove that `sfmg` itself compiled. A black WebView is an outcome,
not a diagnosis.

## Root Cause Stack

### 1. The preview declared "rendered" before Expo actually mounted

`sfmg` is an Expo project. Expo Web's initial HTML can contain several body
children before React has mounted the app: `noscript`, `div#root`, and one or
more scripts. An old readiness heuristic treated `body.children.length > 1` as
"the app rendered".

That is wrong for Expo. It means the injected script can send:

```json
{"t":"yaver-rendered"}
```

while `#root` is still empty. In `apps.tsx`, that flips
`webPreviewContentLoaded` to `true`, which hides the progress/log overlay. Once
that boolean is latched, the user is left with the raw WebView. If the raw page
is black because React has not mounted or has crashed before paint, the screen is
exactly what the recording shows: Yaver header, black content, no explanation.

The current source has the correct shape in `mobile/src/lib/previewReadyScript.ts`:
when it sees `#root` or `#app`, it requires that mount node to have children.
That file's comments explicitly call out this Expo false-positive class and
`sfmg`. Therefore the recording is most consistent with either:

- the phone running an older build than the source currently on disk, or
- another preview path/build still carrying the old readiness predicate.

### 2. The phone did not reliably read `/dev/events`

React Native's `fetch` implementation does not expose a streaming
`response.body.getReader()` like a browser does. The older browser-lane code used
that browser API for `/dev/events`; on device it silently returned without
reading frames.

Consequences:

- agent logs can exist on the Mac mini while the phone shows none;
- `snapshot.recentLogs` never reaches the overlay;
- `ready`, `error`, `phase`, `progress`, and `heartbeat` events do not update
  the visible state;
- startup looks like silence even when the agent is working.

The current repo has `mobile/src/lib/sseClient.ts`, an XHR `onprogress` SSE
client, and `apps.tsx` now imports `subscribeSse`. That is the right fix. The
recording's "no log streaming from Mac mini" symptom matches the old fetch-body
consumer or an installed build that predates this shared client.

### 3. Expo Browser Reload must load `/dev-web/`, not Metro `/dev/`

For React Native / Expo, Metro is not an HTML web app. Loading Metro's native
bundle lane in a WebView is not the same as loading Expo Web.

The browser lane needs the agent to start an Expo Web sibling and proxy it at:

```text
/dev-web/
```

The current agent code in `desktop/agent/devserver.go` starts that sibling for
Expo browser-lane requests and records `webPort`. The current mobile code in
`apps.tsx` prefers `/dev-web/` when `devStatus.webPort` is present.

Older behavior or stale status can still explain the recording:

- `POST /dev/start` succeeds for the native Metro lane;
- `/dev/status` says a dev server exists;
- the phone derives or receives `/dev/`;
- WebView loads something that is not the Expo Web app;
- the content area remains blank or black.

This is the classic false green: inventory says "dev server active", but the
operation "this URL paints the web target" was never proven.

### 4. The UI hid the only diagnostic surface

The bad user experience is not only the blank screen. The deeper bug is that the
preview shell provided no operational facts while it was blank.

At minimum the overlay should have stayed visible until a real paint was proven
and should have shown:

- selected lane: browser / Expo Web;
- workDir: `/Users/pokayoke/Workspace/sfmg`;
- effective preview URL path: `/dev-web/` versus `/dev/`;
- agent state: starting, building, running, failed;
- port: Metro port and web sibling port when applicable;
- SSE state: connected, last frame time, last output time;
- recent logs or "stream unavailable" reason;
- HTTP status from the WebView;
- readiness probe result: `#root` present, root child count, body child count.

Instead, the visible product state collapsed every distinct failure into one
black rectangle.

## Why This Is Not "Just An Ugly UI" Bug

The UI is ugly because it has no truth to render. The product model allowed
these facts to diverge:

- `startDevServer` can return success while the URL the phone loads is wrong.
- `/dev/status` can describe a native/Metro process while the user asked for a
  browser-rendered Expo Web page.
- A WebView can finish loading HTML while the app has not painted.
- A log stream can be broken on the phone while the agent is emitting logs.
- The overlay can be hidden by a one-way success signal and never restored.

Every one of those is a product bug. A polished spinner would only hide the same
failure longer.

## Source Versus Recording Mismatch

The current source already contains fixes/comments for this exact incident
class:

- `mobile/src/lib/previewReadyScript.ts` avoids the Expo empty-root false
  positive.
- `mobile/src/lib/sseClient.ts` uses XHR instead of fetch-body streaming.
- `mobile/app/(tabs)/apps.tsx` imports both shared pieces.
- `desktop/agent/devserver.go` starts an Expo Web sibling and reports
  `/dev-web/`.
- `desktop/agent/devserver_bundleurl_test.go` guards the `/dev-web/` bundle URL
  case.
- `desktop/agent/doctor_browser_lane.go` exists specifically to test whether the
  browser lane actually renders, not merely whether a process is active.

So the leading explanation is not "the repo has no fix". It is:

1. the recorded phone build was stale, or
2. one of the other preview surfaces still used stale logic, or
3. the installed app/agent combination was mixed-version and did not agree on
   `/dev-web/`, SSE, or readiness semantics.

The next investigation must verify the versions actually running on the phone
and Mac mini, not only the code checked out locally.

## Concrete Verification Checklist

Run these against the same Mac mini and same `sfmg` workDir.

### Phone / mobile app

- Confirm the installed Yaver mobile build number and commit/date.
- Confirm the path entered is the Projects browser preview modal in
  `mobile/app/(tabs)/apps.tsx`.
- Confirm the loaded URL shown by the WebView is `/dev-web/` when `webPort` is
  present.
- Confirm `/dev/events` uses the XHR `subscribeSse` client, not a
  `fetch(...).body.getReader()` path.
- Confirm `webPreviewContentLoaded` does not flip true until `#root` has mounted
  children.

### Agent / Mac mini

- `POST /dev/start` for `sfmg` with `web:true` must start Expo Web, not only
  Metro.
- `GET /dev/status` must include `framework:"expo"`, the exact `workDir`,
  `building` or `running`, `bundleUrl:"/dev-web/"`, and `webPort`.
- `GET /dev/events` must produce `snapshot`, `heartbeat`, `log`, `phase`,
  `progress`, `ready`, or `error` frames within seconds.
- The agent logs should include a line like:

```text
[dev:expo] browser lane: expo --web sibling on :<port> (served at /dev-web/)
```

- Loading the same effective URL in a desktop browser through the agent should
  either paint `sfmg` or return a concrete HTTP/build/runtime error.

## Required Product Guards

### P0: Do not hide the overlay on a fragile success signal

Keep the overlay visible until the injected probe proves a real mount:

- for Expo/RN web: `#root` or `#app` exists and has children;
- for Flutter: Flutter host/splash markers are past the loading state;
- for generic web: require meaningful non-script body content.

After a `yaver-rendered` signal, keep a short watchdog alive. If the next few
seconds still show an empty root, black body, or no layout boxes, restore the
overlay and report the probe values.

### P0: Log streaming must be independent of preview success

Subscribe to `/dev/events` as soon as the preview modal opens and keep it alive
until the modal closes, even after the WebView claims it rendered. Users still
need logs for runtime crashes after first paint.

The UI must distinguish:

- stream connected;
- stream unavailable, with HTTP/status reason;
- stream alive but process quiet;
- process emitted output recently.

### P0: The agent should return the exact URL to load

Mobile should not infer `/dev/` versus `/dev-web/` from partial status. The
start/status payload should expose one authoritative field:

```json
{
  "effectivePreviewUrl": "/dev-web/",
  "previewKind": "expo-web",
  "webPort": 12345,
  "nativePort": 8081
}
```

The client can still validate it, but it should not reconstruct the lane from
old assumptions.

### P1: Collapse duplicate preview implementations

`apps.tsx` and `DevPreview.tsx` should share one Browser Preview component/hook
for:

- URL selection;
- WebView readiness;
- SSE parsing;
- retry/deadline logic;
- failure panel rendering.

The screenshot came from `apps.tsx`; earlier audits found `DevPreview.tsx` had
different behavior. This is exactly how one surface stays broken after another
is fixed.

### P1: Add an Expo empty-root regression test

The test should load an Expo-like HTML document:

```html
<body>
  <noscript></noscript>
  <div id="root"></div>
  <script></script>
</body>
```

Expected result: no `yaver-rendered` message.

Then append a child under `#root`.

Expected result: one `yaver-rendered` message.

This test must fail with the old `body.children.length > 1` heuristic.

### P1: Add a device-facing browser-lane doctor

The existing agent-side browser-lane doctor is the right model, but the phone
needs the result in the preview failure panel. The user should see:

```text
Browser lane probe failed
URL: /dev-web/
HTTP: 200
Root: #root present, 0 children
SSE: connected, last heartbeat 3s ago
Last log: Expo Web waiting on...
Remedy: app has not mounted; open logs or inspect Expo error above
```

If the URL is `/dev/` for an Expo browser request, the failure should say that
directly.

## Final Diagnosis

The recording is best explained by a stacked browser-lane failure:

1. `sfmg` opened through the Projects browser preview modal.
2. The phone either loaded the wrong lane (`/dev/` instead of `/dev-web/`) or an
   Expo Web shell whose root had not mounted.
3. The preview readiness logic treated the shell as rendered too early, hiding
   the overlay.
4. The phone did not surface Mac mini logs because the installed build either
   used the old React Native fetch-stream SSE path or hid the log overlay after
   the false rendered signal.
5. The UI had no recovery guard to reclassify "black WebView after success" as a
   failed/diagnosable browser-lane operation.

The fix is not a prettier black screen. The fix is to make the operation
self-evident: load the exact Expo Web URL, prove real mount before hiding the
overlay, keep `/dev/events` streaming regardless of render state, and surface the
browser-lane doctor result on the phone.
