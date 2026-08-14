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
  PNG, auth-protected. For self-hosted boxes.
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

1. `cd web && npm run dev` → `http://localhost:3000/vibing` (sign in) — SSE frames
   via the box (or set Frame source (dev) to `http://localhost:8787` with
   `node scripts/vibing-local-frame.mjs`).
2. tvOS sim → Home → Vibing — control/status + live frames (dev override).
3. Web → pick WebRTC → shows SSE fallback message until the box has a broadcaster.
4. Set `relayTier = pro` (settings API / Convex) to see the Pro messaging.
