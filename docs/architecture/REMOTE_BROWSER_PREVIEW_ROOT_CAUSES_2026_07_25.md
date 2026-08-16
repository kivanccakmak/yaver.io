# Remote browser preview (Flutter + RN) — every reason it did not work

Date: 2026-07-25. Written from measurements on a real Mac mini + a phone on
TestFlight 469/471, not from reading code. Complements
`REMOTE_FLUTTER_WEB_PREVIEW_2026_07_25.md` (the independent Codex audit), which
listed the RN fetch bug as hypothesis #5 — it turned out to be the primary cause.

## The user's experience

> "Starting flutter dev server… 0:04 → 0:50 elapsed · waiting for the first output
> from the box" — for the entire session. No logs, no app, and eventually
> "Not connected".

## Six independent faults, stacked

Each one alone was enough to produce a blank screen. They had to be peeled off in
order, and every layer hid the next.

### 1. The phone never read the log stream (THE big one)

React Native's `fetch` is the whatwg-fetch polyfill: **`response.body` is
undefined**. Four call sites did:

```ts
const res = await fetch(`${baseUrl}/dev/events`, …);
const reader = res.body?.getReader();
if (!reader) return;        // ← every time, silently, forever
```

- `app/(tabs)/apps.tsx` — the preview overlay's logs AND its `ready` handler
- `src/components/DevPreview.tsx` — the other preview implementation
- `src/lib/quic.ts::subscribeDevEvents` — the "shared" client
- `app/(tabs)/apps.tsx` again — Hermes build progress (`/dev/build-native`)

Proof it was the phone and not the box: captured on the mini while the phone
showed nothing —

```
frame types: {log: 5, resources: 1, phase: 3, starting: 1, heartbeat: 7, snapshot: 7, ready: 1}
LOG: Launching lib/main.dart on Web Server in debug mode...
```

Consequences beyond missing logs: the `ready` frame never arrived, so the overlay
never cleared even after the server was serving; and the Hermes lane's live tail
was empty for every build ever run.

The codebase already knew: `quic.ts::streamTaskOutput` and `(tabs)/settings.tsx`
use XHR + `onprogress` with a comment explaining that RN cannot stream a fetch
body. That knowledge never reached these four sites.

**Fix:** `mobile/src/lib/sseClient.ts` — one XHR-based SSE client for the whole
app. Buffers frames across progress events (tested by feeding a real captured
burst in 37-byte chunks), fires `onOpen` at HEADERS_RECEIVED so reachability is
known before any output exists, and reports a non-2xx (401 on a missing relay
password, 404 on an old agent) instead of looking like silence.

### 2. An orphaned dev server made a dead session report `serving: true`

A 23-hour-old `flutter run --web-port 9100` from an unrelated project still held
:9100. The new preview's flutter died with `Address already in use`, and the
readiness probe — a plain `GET` on :9100 — was answered **by the orphan**. So
`/dev/status` said `running:true, serving:true` and the phone was pointed at a
different project's app.

**Fix:** a port broker (`devserver_ports.go`) that reserves at CHOICE time, plus
readiness that rejects a 200 arriving after our own process exited.

### 3. `portBusy` probed the wrong bind

The broker's own check bound `127.0.0.1:<port>`. On the mini, `node` held
`*:8081` (IPv6 wildcard) and binding `127.0.0.1:8081` still **succeeded** — so
Metro's port was called free when Metro could not take it. Binding only the
wildcard then broke the mirror case: Go sets `SO_REUSEADDR`, so a wildcard bind
succeeds next to a loopback listener, and the agent's `/dev/` proxy dials
127.0.0.1 — it would have served the squatter's process to our users.

**Fix:** connect-probe both loopback families first (unambiguous, and it is the
question the proxy actually asks), then wildcard-bind each family.

### 4. A launching dev server reported itself as nothing

`/dev/status` answered `running:false` with no `building` flag while a cold web
compile ran (30s–3min). Mobile's `isActiveDevServerStatus` is
`running || building`, so the phone concluded "no dev server here": contentless
spinner, and the log stream (gated on the same predicate) never opened.

**Fix:** a session that exists and has not failed reports `building:true` with a
label. A FAILED session deliberately does not, so a named failure never becomes an
eternal "Starting…".

### 5. Only Expo filled `bundleUrl`

`/dev/status` for Flutter/Vite/Next/React Native/SwiftWasm returned
`bundleUrl:""` even though each framework implements `BundleURL()` correctly —
only `ExpoDevServer.Status()` copied it. The phone's fallback to `/dev/` masked
it; the web dashboard had no such luck.

**Fix:** derived in `DevServerManager.Status()` from the interface method, so
omission cannot reintroduce it. A registry-walking test fails for 5 of 6
frameworks without it.

### 6. The app itself does not compile — and nothing said so

With all five above fixed, `e-mobile` still showed nothing. The stream finally
told us why:

```
…/font_awesome_flutter-10.12.0/lib/src/icon_data.dart:104:36: Error: The class
'IconData' can't be extended outside of its library because it's a final class.
Failed to compile application.
```

`pubspec.lock` pins **font_awesome_flutter 10.12.0** (a transitive dependency)
against **Flutter 3.44 / Dart 3.12**, where `IconData` became a `final class`.
Flutter's web-server keeps listening and answers `index.html`, so readiness
passed, the proxy returned 200, and the phone rendered black — indefinitely.

**Project fix (in the user's repo, not Yaver):**

```yaml
# pubspec.yaml
dependency_overrides:
  font_awesome_flutter: ^11.0.0   # 10.12.0 cannot compile on Flutter 3.44+
```
then `flutter pub get`.

**Product fix:** `recordRecentLog` now recognises a build-failure line (Flutter,
Metro, Vite, Next, xcodebuild phrasings) and emits a first-class `error` event
carrying the summary plus the concrete cause. A dev server that is up but has
nothing to serve is a failure, and it says so.

## Proof the lane works

Same box, same agent, a project that compiles (`yaver-todo-flutter`), through the
agent's `/dev/` proxy — which is exactly what the phone loads:

```
index.html    HTTP 200 1525B   <base href="./">   ← base-href rewrite works
main.dart.js  HTTP 200
flutter.js    HTTP 200
```

## Adjacent finds from the same session

- **Apple simulator lane reported a false negative.** The capability probe gave
  `xcrun simctl list runtimes` 4 seconds; `xcrun simctl help` alone takes **17
  seconds** on that mini, so every Apple target said "iOS runtime not installed"
  with iOS 26.4 installed and a device booted. Runtimes are now read off disk
  (mounted volumes + `images.plist` + classic bundles); "could not determine" is
  reported separately from "absent". After the fix: ios/ipados/watchos
  `enabled=true`, tvos/visionos genuinely absent.
- **Simulator concurrency.** `pickSimulator` scored booted +100 and returned only
  the winner, so every session on the machine drove the SAME simulator. Now a
  ranked list plus exclusive claims per vibe session.
- **Android tools invisible to the agent.** `emulator` and `avdmanager` came back
  MISSING through the agent's own exec while
  `~/Library/Android/sdk/emulator/emulator` existed; a launchd daemon inherits
  neither the user's PATH nor `ANDROID_HOME`. Both now come from the existing SDK
  discovery.

## The honest lesson

Five of the six faults were **something reporting success or silence while the
operation was impossible** — and my own first fix (`portBusy`) contained a fresh
instance of the same mistake. Component-level verification (`curl` against the
agent) said "working" while the product was broken for the user. The only
verification that counted was the one that reproduced what the phone does.
