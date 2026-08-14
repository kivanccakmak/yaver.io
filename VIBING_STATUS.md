# Yaver Vibing — Status Dump

> Cross-surface live preview of a project running on the remote box (dev-server
> browser lane), streamed to **tvOS / web / mobile**.

## What we're trying

Stream the remote box's running app live to clients. Two transports:

- **SSE (free, default)** — headless-Chrome frames over HTTP through the existing relay.
- **WebRTC over TURN (Relay Pro)** — low-latency media relay, the monetization.

A user preference (`auto | sse | webrtc`) + a relay tier (`free | pro`) live in
Convex `userSettings`. The **free Yaver relay** provides STUN (free ICE) and
TURN (gated to Relay Pro) on the same port.

## Audit — 2026-08-14

The implementation has three distinct layers that must not be conflated in
release notes or testing:

| Lane | Actual state | Ubuntu 4 GB readiness |
| --- | --- | --- |
| Image preview (labelled SSE) | Authenticated PNG **polling** every 2.5 seconds. It is not an SSE event stream; the agent starts headless Chrome to capture a frame. | Usable for one/few viewers after the capture cache below; Chrome and the dev server need memory headroom. |
| WebRTC | The web client can create an offer, but the in-repo agent has no `/rtc/offer` handler or broadcaster. The managed agent must be verified separately. | Not testable as a real media lane yet. |
| TURN | Pion TURN listens on UDP+TCP 3478, but its REST-HMAC authentication requires time-limited credentials. The web client currently sends placeholder credentials, so TURN allocation cannot succeed. | Binding is testable; authenticated media relay is not. |

Additional audit findings:

- The source-tree agent does **not** expose `/dev/start`, `/dev/status`,
  `/dev/stream`, or `/dev/stop`. Those endpoints in the clients only work
  against the separately managed box build; this repository cannot reproduce
  that portion until its implementation is brought into source control.
- `/vibing/frame` formerly accepted arbitrary URLs. It is now restricted to
  `http://localhost`/loopback URLs, so an authenticated user cannot turn
  headless Chrome into a host-network request proxy.
- Frame captures are now serialized and cached for 900 ms. Several viewers
  therefore reuse one capture instead of causing concurrent Chrome processes,
  which is important on the 4 GB Ubuntu test host.
- The local frame fixture now handles browser CORS preflight with the
  `Authorization` header. It works for the web page and the tvOS simulator;
  the native simulator does not itself enforce browser CORS.
- Relay tier is still a user-controlled settings value, not billing authority.
  It must not be used as a security gate for TURN credentials.

## Done (committed to `main`)

- **Convex**
  - `userSettings.vibingTransport` (`auto|sse|webrtc`) + `/settings` passthrough.
  - `userSettings.relayTier` (`free|pro`, default free) + `/settings` passthrough.
  - `platformConfig.relay_ice` → `/config` exposes `{ stun: "stun:public.yaver.io:3478", turn: "turn:public.yaver.io:3478" }`.
- **Settings (tvOS + mobile)** — transport picker (Auto/SSE/WebRTC), persisted to Convex + AsyncStorage.
- **tvOS Vibing** — project picker → start/stop box preview, live status
  (framework/port/session/health), **live frame renderer** (`/vibing/frame` +
  dev frame-source override), transport + tier badge, free-limit messaging.
- **Web `/vibing`** — device picker, project list, click → start preview,
  **transport selector**, **WebRTC path** (`RTCPeerConnection` + free STUN +
  Pro TURN, signaling via box `/rtc/offer`, `<video>` render, SSE fallback),
  SSE frames, tier badge + free-limit note. Header link. `next build` passes.
- **Agent `GET /vibing/frame`** (`desktop/agent`) — headless-Chrome capture →
  PNG, auth-protected and loopback-only. Concurrent requests share a 900 ms
  cache to protect small Ubuntu hosts. For self-hosted boxes.
- **Relay TURN** (`relay/turn.go`) — pion/turn server (UDP+TCP, `--turn-port`
  default 3478), REST auth (`HMAC-SHA1(secret, username)`), doubles as STUN.
  Verified binding on UDP+TCP.
- **Headless lane test** — `scripts/vibing-headless-test.mjs` (login → `/dev/start`
  → `/dev/status` serving → `/dev/stream` → asset-auth check → stop). Proves the
  lane works with auth; pinpoints `asset (no-auth) → 401`.
- **Local frame server** — `scripts/vibing-local-frame.mjs` (generated live PNGs
  for simulator/web dev testing, no Chrome dependency).
- **Android TV Kotlin YaverSpeech** (STT `SpeechRecognizer` + TTS `TextToSpeech`)
  + config plugin injection + RECORD_AUDIO permission.
- **tvOS YaverSpeech** — TTS (`AVSpeechSynthesizer`) + mic recording
  (`AVAudioEngine` → wav), config plugin + podspec (iOS+tvos).
- **TV app** — card home, inline task session (no Modal), focus fixes, optimistic
  follow-up bubbles, connection/relay-password fixes, keyboard single-line
  Return-to-send, console-style output view.

## Not done

- **WebRTC on tvOS** — blocked: `react-native-webrtc`'s dep `JitsiWebRTC` has no
  tvOS slice → cannot build for tvOS (verified). Would need a custom WebRTC build
  for tvOS (heavy). tvOS/mobile stay on SSE.
- **Box WebRTC broadcaster + signaling** — the managed box (v1.99.411) has no
  `/rtc/offer`; Web WebRTC currently shows the SSE fallback until the box agent
  adds a broadcaster + signaling.
- **TURN credential issuer** — the browser currently uses placeholder TURN
  credentials, which cannot satisfy relay REST-HMAC authentication. Add a
  server-side, short-lived credential endpoint after Relay Pro entitlement is
  authoritative; never expose the TURN secret to clients.
- **Actual SSE transport** — the free lane is PNG polling, not SSE. Either
  rename it to `frames` in product copy or add a framed SSE endpoint and a
  streaming client parser. The latter is not available in React Native/tvOS by
  default, so it needs a native-compatible design before replacing polling.
- Managed box lacks `/vibing/frame` (self-host boxes have it via the repo agent).
- **Mobile (iOS/Android) vibing view** not ported (tvOS + web done).
- **Relay Pro billing gate** — tier is a manual flag; billing (LemonSqueezy) not
  wired to auto-set `relayTier = pro`.
- **Cloudflare web deploy** — the web still ships via Vercel (`deploy-vercel.sh`).

## Corrections / decisions

- **Never Vercel — always Cloudflare for web.** Web deploy must be switched to
  Cloudflare Pages/Workers (wrangler). Pending.
- **Transport is optional** (user preference) — validation stage.
- **Free relay limits**: Free = SSE frames + STUN. Exceeding → buy **Relay Pro**
  (TURN/WebRTC) or self-host the relay.

## Validation-stage test path

1. On the Ubuntu 4 GB box, install Chromium and keep swap enabled. Build the
   updated `desktop/agent`; run its existing managed preview service only if it
   actually provides the `/dev/*` endpoints. Confirm `/vibing/frame` rejects a
   non-loopback URL and returns a PNG for the local preview URL.
2. On this Mac, run `node scripts/vibing-local-frame.mjs`. In the web Vibing
   page or tvOS simulator set **Frame source (dev)** to
   `http://localhost:8787`; start a serving preview on the selected box. The
   changing colour confirms rendered frames, not merely an HTTP status check.
3. Exercise the real free lane against Ubuntu without the override and record
   capture latency, Chrome RSS, agent RSS, and dropped/failed frames with one
   and then two viewers.
4. Do **not** call WebRTC passing just because the UI displays an SSE fallback.
   A real WebRTC test requires: agent `/rtc/offer`, a video track, valid
   short-lived TURN credentials, UDP and TCP 3478 open, and a relay-candidate
   connection verified in browser `chrome://webrtc-internals`.
5. tvOS remains a frame-lane test only until a tvOS-compatible WebRTC native
   build is supplied.
